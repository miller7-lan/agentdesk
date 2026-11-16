import base64
import hashlib
import json
import os
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from protocol import MAX_CHUNK, MAX_FRAME, ProtocolError, decode, message_expiry, validate_data
from server import RateLimit
from state import MAX_CONNECTIONS, Receipts, load_devices


def message_id(created=None):
    timestamp = int((time.time() if created is None else created) * 1000)
    bits = (timestamp << 80) | (7 << 76) | (secrets.randbits(12) << 64)
    bits |= (2 << 62) | secrets.randbits(62)
    return str(uuid.UUID(int=bits))



def data(device, task=None, kind="task.request", body=None):
    return dict(type="data", device_id=device, task_id=task or str(uuid.uuid4()),
                message_id=message_id(), kind=kind, body={} if body is None else body)


def chunk(stream, offset, payload):
    return dict(stream_id=stream, offset=offset, data=base64.b64encode(payload).decode(),
                sha256=hashlib.sha256(payload).hexdigest())


class ValidationTests(unittest.TestCase):
    def test_frame_and_chunk_validation(self):
        with self.assertRaisesRegex(ProtocolError, "invalid_frame"):
            decode(b'{"type":"data","type":"ack"}\n')
        with self.assertRaisesRegex(ProtocolError, "frame_too_large"):
            decode(b" " * MAX_FRAME + b"\n")
        body = chunk(str(uuid.uuid4()), 0, b"example")
        frame = data("bridge", kind="stream.chunk", body=body)
        self.assertEqual(decode(validate_data(frame)), frame)
        body["sha256"] = "0" * 64
        with self.assertRaisesRegex(ProtocolError, "checksum_mismatch"):
            validate_data(frame)
        with self.assertRaisesRegex(ProtocolError, "expired_id"):
            message_expiry(message_id(946684800))
        with self.assertRaisesRegex(ProtocolError, "future_id"):
            message_expiry(message_id(time.time() + 60))

    def test_rate_limits_frames_bytes_and_refills(self):
        with patch("server.time.monotonic", return_value=0) as clock:
            limiter = RateLimit()
            for _ in range(240):
                limiter.consume(16)
            with self.assertRaisesRegex(ProtocolError, "rate_limit"):
                limiter.consume(16)
            clock.return_value = 1
            limiter.consume(1024 * 1024)
            with self.assertRaisesRegex(ProtocolError, "rate_limit"):
                limiter.consume(1)

    def test_receipt_scope_expiry_and_capacity(self):
        receipts = Receipts(":memory:")
        self.addCleanup(receipts.db.close)
        now = time.time()
        with patch("state.MAX_RECEIPTS", 1):
            self.assertEqual(receipts.reserve("one", "a", "b", "task", b"a", now - 1, False),
                             "peer_offline")
            self.assertEqual(receipts.reserve("one", "a", "b", "task", b"a", now - 1, True), "new")
            self.assertEqual(receipts.reserve("one", "x", "b", "task", b"a", now, True), "id_conflict")
            self.assertEqual(receipts.reserve("two", "a", "b", "task", b"a", now, True),
                             "receipt_capacity")
            receipts.sweep()
            self.assertEqual(receipts.reserve("two", "a", "b", "task", b"a", now, True), "new")

    def test_one_way_pair_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            registry = Path(tmp) / "devices.json"
            registry.write_text(json.dumps({
                "bridge": {"role": "bridge", "peer": "absent", "token_sha256": "0" * 64},
            }))
            with self.assertRaisesRegex(ValueError, "reciprocal"):
                load_devices(registry)


class Client:
    def __init__(self, sock, name):
        self.sock = sock
        self.name = name
        self.reader = sock.makefile("rb")

    def send(self, frame):
        self.sock.sendall(json.dumps(frame).encode() + b"\n")

    def read(self):
        line = self.reader.readline()
        return json.loads(line) if line else None

    def close(self):
        self.reader.close()
        self.sock.close()

    def check(self, kind, frame):
        self.send(dict(type=kind, device_id=self.name, task_id=frame["task_id"],
                       message_id=frame["message_id"]))


@unittest.skipUnless(shutil.which("openssl"), "openssl required for local TLS fixture")
class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(folder.cleanup)
        cls.certs = Path(folder.name)
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-days", "1", "-subj", "/CN=localhost",
                        "-addext", "subjectAltName=DNS:localhost",
                        "-keyout", str(cls.certs / "key"), "-out", str(cls.certs / "cert")],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        self.tokens = {name: secrets.token_urlsafe(32) for name in ("bridge", "orch")}
        self.registry = self.folder / "devices.json"
        self.save_registry()
        self.start_server()
        self.addCleanup(self.stop_server)

    def save_registry(self):
        devices = {}
        for name, role, peer in (("bridge", "bridge", "orch"), ("orch", "orchestrator", "bridge")):
            devices[name] = dict(role=role, peer=peer,
                                 token_sha256=hashlib.sha256(self.tokens[name].encode()).hexdigest())
        staged = self.folder / "devices.tmp"
        staged.write_text(json.dumps(devices))
        staged.replace(self.registry)

    def start_server(self):
        self.process = subprocess.Popen([
            sys.executable, str(ROOT / "server.py"), "--bind", "127.0.0.1", "--port", "0",
            "--cert", str(self.certs / "cert"), "--key", str(self.certs / "key"),
            "--devices", str(self.registry), "--database", str(self.folder / "receipts.db"),
        ], stderr=subprocess.PIPE, text=True, env={**os.environ, "PYTHONUNBUFFERED": "1"})
        line = self.process.stderr.readline()
        if "listening" not in line:
            _, stderr = self.process.communicate(timeout=8)
            self.fail(line + stderr)
        self.port = int(line.rsplit("=", 1)[1])

    def stop_server(self):
        if self.process.poll() is None:
            self.process.terminate()
        _, stderr = self.process.communicate(timeout=8)
        self.assertEqual(self.process.returncode, 0, stderr)

    def connect(self, name, token=None, expect="welcome", hostname="localhost"):
        context = ssl.create_default_context(cafile=str(self.certs / "cert"))
        with socket.create_connection(("127.0.0.1", self.port), timeout=6) as sock:
            client = Client(context.wrap_socket(sock, server_hostname=hostname), name)
        self.addCleanup(client.close)
        client.send(dict(type="hello", version=1, device_id=name,
                         token=self.tokens[name] if token is None else token))
        frame = client.read()
        self.assertEqual(frame["type"], expect, frame)
        return client, frame

    def pair(self):
        bridge, welcome = self.connect("bridge")
        self.assertFalse(welcome["peer_online"])
        orch, welcome = self.connect("orch")
        self.assertTrue(welcome["peer_online"])
        self.assertEqual(bridge.read(), dict(type="presence", device_id="orch", online=True))
        return bridge, orch

    def transfer(self, sender, recipient, frame):
        sender.send(frame)
        self.assertEqual(recipient.read(), frame)
        self.assertEqual(sender.read()["state"], "pending")
        recipient.check("ack", frame)
        self.assertEqual(recipient.read()["state"], "acknowledged")
        self.assertEqual(sender.read()["state"], "acknowledged")

    def test_bidirectional_multichunk_transfer_and_result(self):
        bridge, orch = self.pair()
        for sender, recipient in ((orch, bridge), (bridge, orch)):
            task, stream = str(uuid.uuid4()), str(uuid.uuid4())
            pieces = [os.urandom(MAX_CHUNK), os.urandom(137)]
            content = b"".join(pieces)
            self.transfer(sender, recipient, data(sender.name, task, "stream.open",
                                                  dict(stream_id=stream, size=len(content))))
            offset = 0
            for piece in pieces:
                self.transfer(sender, recipient, data(sender.name, task, "stream.chunk",
                                                      chunk(stream, offset, piece)))
                offset += len(piece)
            self.transfer(sender, recipient, data(sender.name, task, "stream.end",
                                                  dict(stream_id=stream, size=offset,
                                                       sha256=hashlib.sha256(content).hexdigest())))
            self.transfer(recipient, sender, data(recipient.name, task, "result", {"ok": True}))

    def test_offline_reconnect_restart_and_no_replay(self):
        bridge, orch = self.pair()
        write = data("orch", kind="file.write", body={"path": "file.txt"})
        orch.send(write)
        self.assertEqual(bridge.read(), write)
        self.assertEqual(orch.read()["state"], "pending")
        bridge.close()
        self.assertEqual(orch.read()["online"], False)
        command = data("orch", kind="command.execute")
        orch.send(command)
        self.assertEqual(orch.read()["state"], "peer_offline")
        bridge, _ = self.connect("bridge")
        self.assertTrue(orch.read()["online"])
        self.transfer(orch, bridge, command)
        self.stop_server()
        self.start_server()
        bridge, orch = self.pair()
        orch.check("status", write)
        self.assertEqual(orch.read()["state"], "pending")
        orch.send(write)
        self.assertEqual(orch.read()["state"], "pending")
        orch.send({**write, "body": {"path": "different.txt"}})
        self.assertEqual(orch.read()["state"], "id_conflict")
        orch.check("status", command)
        self.assertEqual(orch.read()["state"], "acknowledged")
        bridge.send({"type": "ping", "device_id": "bridge"})
        self.assertEqual(bridge.read(), {"type": "pong"})
        bridge.check("ack", write)
        self.assertEqual(bridge.read()["state"], "acknowledged")
        self.assertEqual(orch.read()["state"], "acknowledged")

    def test_connection_cap_preserves_authenticated_pair(self):
        bridge, _ = self.pair()
        context = ssl.create_default_context(cafile=str(self.certs / "cert"))
        for _ in range(MAX_CONNECTIONS - 2):
            with socket.create_connection(("127.0.0.1", self.port), timeout=2) as sock:
                idle = context.wrap_socket(sock, server_hostname="localhost")
                self.addCleanup(idle.close)
        with self.assertRaises(OSError):
            self.connect("bridge")
        bridge.send({"type": "ping", "device_id": "bridge"})
        self.assertEqual(bridge.read(), {"type": "pong"})

    def test_tls_authentication_sender_binding_and_rotation(self):
        with self.assertRaises(ssl.SSLCertVerificationError):
            self.connect("bridge", hostname="untrusted.invalid")
        _, denial = self.connect("bridge", token=secrets.token_urlsafe(32), expect="protocol_error")
        self.assertEqual(denial["code"], "unauthorized")
        bridge, orch = self.pair()
        bridge.send({"type": "ping", "device_id": "orch"})
        self.assertEqual(bridge.read()["code"], "sender_mismatch")
        self.assertFalse(orch.read()["online"])
        bridge, _ = self.connect("bridge")
        self.assertTrue(orch.read()["online"])
        old = self.tokens["bridge"]
        self.tokens["bridge"] = secrets.token_urlsafe(32)
        self.save_registry()
        self.assertFalse(orch.read()["online"])
        _, denial = self.connect("bridge", token=old, expect="protocol_error")
        self.assertEqual(denial["code"], "unauthorized")
        _, welcome = self.connect("bridge")
        self.assertTrue(welcome["peer_online"])


if __name__ == "__main__":
    unittest.main()
