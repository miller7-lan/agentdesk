"""Device pairing and bounded persistent delivery receipts."""
import hashlib
import hmac
import json
import sqlite3
import time
from dataclasses import dataclass

from protocol import DEVICE_PATTERN, DIGEST_PATTERN, TOKEN_PATTERN

MAX_CONNECTIONS = 16
MAX_DEVICES = 128
MAX_RECEIPTS = 100_000


@dataclass(frozen=True)
class Device:
    role: str
    peer: str
    token_sha256: str


def load_devices(path):
    with path.open(encoding="utf-8") as handle:
        raw = handle.read(65537)
    if len(raw) > 65536:
        raise ValueError("device registry exceeds 65536 characters")
    devices = json.loads(raw)
    if not isinstance(devices, dict) or len(devices) > MAX_DEVICES:
        raise ValueError("invalid devices registry")
    registry = {}
    for name, entry in devices.items():
        if (not DEVICE_PATTERN.fullmatch(name) or not isinstance(entry, dict)
                or entry.keys() != {"role", "peer", "token_sha256"}
                or entry["role"] not in ("bridge", "orchestrator")
                or not isinstance(entry["peer"], str)
                or not isinstance(entry["token_sha256"], str)
                or not DIGEST_PATTERN.fullmatch(entry["token_sha256"])):
            raise ValueError("invalid device entry")
        registry[name] = Device(**entry)
    if len({d.token_sha256 for d in registry.values()}) != len(registry):
        raise ValueError("device tokens must be unique")
    for name, device in registry.items():
        peer = registry.get(device.peer)
        if not peer or peer.peer != name or peer.role == device.role:
            raise ValueError("device pairs must be reciprocal with opposite roles")
    return registry


def authenticate(registry, name, token):
    if (not isinstance(name, str) or not DEVICE_PATTERN.fullmatch(name)
            or not isinstance(token, str) or not TOKEN_PATTERN.fullmatch(token)):
        return None
    device = registry.get(name)
    digest = hashlib.sha256(token.encode("ascii")).hexdigest()
    if device and hmac.compare_digest(device.token_sha256, digest):
        return device
    return None


class Receipts:
    def __init__(self, path):
        self.db = sqlite3.connect(path, timeout=0.25, isolation_level=None)
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.execute("PRAGMA synchronous = FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS receipts (
                message_id TEXT PRIMARY KEY,
                sender TEXT NOT NULL,
                recipient TEXT NOT NULL,
                task TEXT NOT NULL,
                digest BLOB NOT NULL,
                expires REAL NOT NULL,
                acknowledged INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS receipt_expiration ON receipts (expires);
        """)
        self.sweep()

    def sweep(self):
        self.db.execute("DELETE FROM receipts WHERE expires <= ?", (time.time(),))
        self.count = self.db.execute("SELECT count(*) FROM receipts").fetchone()[0]

    def lookup(self, message_id):
        return self.db.execute(
            "SELECT sender, recipient, task, digest, acknowledged FROM receipts "
            "WHERE message_id = ?", (message_id,),
        ).fetchone()

    def reserve(self, message_id, sender, target, task, digest, expires, online):
        old = self.lookup(message_id)
        if old:
            if old[:4] != (sender, target, task, digest):
                return "id_conflict"
            return "acknowledged" if old[4] else "pending"
        if not online:
            return "peer_offline"
        if self.count >= MAX_RECEIPTS:
            return "receipt_capacity"
        self.db.execute(
            "INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?, 0)",
            (message_id, sender, target, task, digest, expires),
        )
        self.count += 1
        return "new"

    def acknowledge(self, message_id):
        self.db.execute("UPDATE receipts SET acknowledged = 1 WHERE message_id = ?", (message_id,))
