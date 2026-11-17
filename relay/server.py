"""Bounded TLS relay. Run with Python 3.10 or newer."""
import argparse
import asyncio
import hashlib
import logging
import signal
import socket
import ssl
import time
from pathlib import Path

from protocol import (
    MAX_FRAME, ProtocolError, decode, encode, identifier, message_expiry,
    require, validate_data,
)
from state import MAX_CONNECTIONS, Receipts, authenticate, load_devices

LOG = logging.getLogger("agentdesk-relay")
HANDSHAKE_TIMEOUT = 5
IDLE_TIMEOUT = 60
WRITE_TIMEOUT = 5


class RateLimit:
    def __init__(self):
        self.last = time.monotonic()
        self.frames = 240
        self.bytes = 1024 * 1024

    def consume(self, size):
        now = time.monotonic()
        elapsed = now - self.last
        self.last = now
        self.frames = min(240, self.frames + 120 * elapsed)
        self.bytes = min(1024 * 1024, self.bytes + 4 * 1024 * 1024 * elapsed)
        require(self.frames >= 1 and self.bytes >= size, "rate_limit")
        self.frames -= 1
        self.bytes -= size


class AddressGuard:
    """Per-address limits in front of authentication. One address may hold only a few connections that have
    not yet authenticated, and an address that keeps presenting bad tokens is turned away for a while, so a
    scanner or a stale client cannot fill the relay's few connection slots or keep guessing."""

    def __init__(self, pending=4, failures=8, window=600, ban=900, clock=time.monotonic):
        self.limit, self.max_failures, self.window, self.ban = pending, failures, window, ban
        self.clock = clock
        self.pending = {}
        self.failures = {}
        self.banned = {}

    def admit(self, address):
        now = self.clock()
        until = self.banned.get(address)
        if until is not None:
            if until > now:
                return False
            del self.banned[address]
        if self.pending.get(address, 0) >= self.limit:
            return False
        self.pending[address] = self.pending.get(address, 0) + 1
        return True

    def settled(self, address):
        count = self.pending.get(address, 0) - 1
        if count > 0:
            self.pending[address] = count
        else:
            self.pending.pop(address, None)

    def fail(self, address):
        now = self.clock()
        recent = [t for t in self.failures.get(address, []) if now - t < self.window] + [now]
        self.failures[address] = recent
        if len(recent) >= self.max_failures:
            self.banned[address] = now + self.ban
            del self.failures[address]

    def sweep(self):
        now = self.clock()
        self.banned = {a: t for a, t in self.banned.items() if t > now}
        self.failures = {a: r for a, r in self.failures.items() if any(now - t < self.window for t in r)}


class Connection:
    def __init__(self, reader, writer, address=None, guard=None):
        self.reader = reader
        self.writer = writer
        self.address = address
        self.guard = guard
        self.pending = guard is not None
        self.name = None
        self.device = None
        self.lock = asyncio.Lock()
        self.rate = RateLimit()

    async def read(self, timeout=IDLE_TIMEOUT):
        try:
            line = await asyncio.wait_for(self.reader.readuntil(b"\n"), timeout)
        except asyncio.LimitOverrunError as exc:
            raise ProtocolError("frame_too_large") from exc
        self.rate.consume(len(line))
        return decode(line)

    async def send(self, frame):
        wire = frame if isinstance(frame, bytes) else encode(frame)
        async with self.lock:
            if self.writer.is_closing():
                return False
            try:
                self.writer.write(wire)
                await asyncio.wait_for(self.writer.drain(), WRITE_TIMEOUT)
                return True
            except (OSError, asyncio.TimeoutError, TimeoutError):
                self.close()
                return False

    def settle(self):
        if self.pending:
            self.pending = False
            self.guard.settled(self.address)

    def close(self):
        self.settle()
        self.writer.transport.abort()


class Relay:
    def __init__(self, devices_path, database):
        self.devices_path = devices_path
        self.devices = load_devices(devices_path)
        self.receipts = Receipts(database)
        self.online = {}
        self.guard = None

    def peer(self, connection):
        peer = self.online.get(connection.device.peer)
        return peer if peer and not peer.writer.is_closing() else None

    async def presence(self, connection):
        peer = self.peer(connection)
        if peer:
            current = self.online.get(connection.name)
            await peer.send({"type": "presence", "device_id": connection.name,
                             "online": bool(current and not current.writer.is_closing())})

    async def authenticate(self, connection):
        frame = await connection.read(HANDSHAKE_TIMEOUT)
        require(frame.keys() == {"type", "version", "device_id", "token"}
                and frame["type"] == "hello"
                and type(frame["version"]) is int and frame["version"] == 1, "invalid_hello")
        name = frame["device_id"]
        device = authenticate(self.devices, name, frame["token"])
        if device is None and connection.guard:
            connection.guard.fail(connection.address)
        require(device is not None, "unauthorized")
        connection.settle()
        connection.name, connection.device = name, device
        previous = self.online.get(name)
        if previous:
            previous.close()
        self.online[name] = connection
        await connection.send({"type": "welcome", "version": 1, "device_id": name,
                               "role": device.role, "peer_id": device.peer,
                               "peer_online": self.peer(connection) is not None,
                               "max_frame": MAX_FRAME, "idle_seconds": IDLE_TIMEOUT})
        LOG.info("connected device=%s role=%s", name, device.role)
        await self.presence(connection)

    async def serve(self, connection):
        try:
            await self.authenticate(connection)
            while self.online.get(connection.name) is connection and not connection.writer.is_closing():
                frame = await connection.read()
                if connection.writer.is_closing() or self.online.get(connection.name) is not connection:
                    break
                await self.handle(connection, frame)
        except ProtocolError as exc:
            await connection.send({"type": "protocol_error", "code": str(exc)})
            LOG.info("protocol disconnect device=%s code=%s", connection.name, exc)
        except (OSError, asyncio.TimeoutError, TimeoutError, asyncio.IncompleteReadError):
            pass
        finally:
            connection.close()
            if connection.name and self.online.get(connection.name) is connection:
                del self.online[connection.name]
                LOG.info("disconnected device=%s", connection.name)
                await self.presence(connection)

    async def handle(self, connection, frame):
        kind = frame.get("type")
        require(frame.get("device_id") == connection.name, "sender_mismatch")
        if kind == "ping":
            require(frame.keys() == {"type", "device_id"})
            await connection.send({"type": "pong"})
            return

        require(kind in ("data", "ack", "status"))
        task, message = frame.get("task_id"), frame.get("message_id")
        identifier(task)
        identifier(message, 7)
        response = {"type": "receipt", "task_id": task, "message_id": message}
        peer_id = connection.device.peer

        try:
            expires = message_expiry(message)
        except ProtocolError as exc:
            await connection.send({**response, "state": str(exc)})
            return

        if kind == "data":
            wire = validate_data(frame)
            peer = self.peer(connection)
            state = self.receipts.reserve(message, connection.name, peer_id, task,
                                          hashlib.sha256(wire).digest(), expires, peer is not None)
            if state == "new":
                await peer.send(wire)
                record = self.receipts.lookup(message)
                state = "acknowledged" if record and record[4] else "pending"
            await connection.send({**response, "state": state})
            return

        require(frame.keys() == {"type", "device_id", "task_id", "message_id"})
        record = self.receipts.lookup(message)
        sender, recipient = (connection.name, peer_id) if kind == "status" else (peer_id, connection.name)
        if record is None or record[:3] != (sender, recipient, task):
            await connection.send({**response, "state": "unknown"})
            return
        if kind == "status":
            await connection.send({**response, "state": "acknowledged" if record[4] else "pending"})
            return
        self.receipts.acknowledge(message)
        notice = {**response, "state": "acknowledged"}
        await connection.send(notice)
        peer = self.peer(connection)
        if peer:
            await peer.send(notice)

    async def maintain(self):
        invalid = False
        while True:
            await asyncio.sleep(2)
            try:
                devices = load_devices(self.devices_path)
            except (OSError, ValueError, RecursionError):
                if not invalid:
                    LOG.error("device registry unavailable or invalid; closing authenticated connections")
                devices, invalid = {}, True
            else:
                if invalid:
                    LOG.info("device registry recovered")
                invalid = False
            if devices != self.devices:
                for name, connection in list(self.online.items()):
                    if devices.get(name) != self.devices.get(name) or (
                        devices.get(connection.device.peer) is None
                    ):
                        connection.close()
                self.devices = devices

    async def sweep(self):
        while True:
            await asyncio.sleep(60)
            self.receipts.sweep()
            if self.guard:
                self.guard.sweep()
            self.receipts.db.execute("PRAGMA wal_checkpoint(PASSIVE)")
            LOG.info("health devices_online=%d receipts=%d", len(self.online), self.receipts.count)


async def handle_socket(sock, tls, relay, address=None):
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_FRAME)
    protocol = asyncio.StreamReaderProtocol(reader)
    try:
        transport, _ = await loop.connect_accepted_socket(
            lambda: protocol, sock, ssl=tls, ssl_handshake_timeout=HANDSHAKE_TIMEOUT,
        )
    except (OSError, asyncio.TimeoutError, TimeoutError):
        sock.close()
        if relay.guard:
            relay.guard.settled(address)
        return
    writer = asyncio.StreamWriter(transport, protocol, reader, loop)
    await relay.serve(Connection(reader, writer, address, relay.guard))


async def run(args):
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    tls.load_cert_chain(args.cert, args.key)
    relay = Relay(args.devices, args.database)
    relay.guard = AddressGuard(pending=args.pending_per_address)
    loop = asyncio.get_running_loop()
    clients = set()
    stop = asyncio.Event()
    failures = []
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stop.set)

    family = socket.AF_INET6 if ":" in args.bind else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as listener:
        if family == socket.AF_INET6:
            listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.setblocking(False)
        listener.bind((args.bind, args.port))
        listener.listen(MAX_CONNECTIONS)
        LOG.info("listening %s port=%d", args.bind, listener.getsockname()[1])

        def client_done(task):
            clients.discard(task)
            if not task.cancelled() and task.exception():
                LOG.error("client connection failed (%s)", type(task.exception()).__name__)
                if isinstance(task.exception(), OSError):
                    return
                failures.append(task.exception())
                stop.set()

        async def accept():
            while True:
                sock, peer = await loop.sock_accept(listener)
                address = peer[0] if isinstance(peer, tuple) else str(peer)
                if len(clients) >= MAX_CONNECTIONS or not relay.guard.admit(address):
                    sock.close()
                    await asyncio.sleep(0)
                    continue
                task = asyncio.create_task(handle_socket(sock, tls, relay, address))
                clients.add(task)
                task.add_done_callback(client_done)

        services = [asyncio.create_task(coro) for coro in (accept(), relay.maintain(), relay.sweep())]
        stopped = asyncio.create_task(stop.wait())
        try:
            done, _ = await asyncio.wait([stopped, *services], return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            if failures:
                raise RuntimeError("client service failed") from failures[0]
        finally:
            remaining = [stopped, *services, *clients]
            for task in remaining:
                task.cancel()
            await asyncio.gather(*remaining, return_exceptions=True)
            relay.receipts.db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=22022)
    parser.add_argument("--pending-per-address", type=int, default=4,
                        help="connections one address may hold before it authenticates")
    for option in ("cert", "key", "devices", "database"):
        parser.add_argument("--" + option, type=Path, required=True)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
