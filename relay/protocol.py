"""AgentDesk relay v1 wire format."""
import base64
import binascii
import hashlib
import json
import re
import time
import uuid

MAX_FRAME = 192 * 1024
MAX_CHUNK = 96 * 1024
RECEIPT_SECONDS = 86400
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}")
DEVICE_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
DIGEST_PATTERN = re.compile(r"[0-9a-f]{64}")
KINDS = {
    "task.request", "file.read", "file.write", "file.patch", "command.execute",
    "result", "error", "task.status", "stream.open", "stream.chunk", "stream.end",
}


class ProtocolError(Exception):
    pass


def require(condition, code="invalid_frame"):
    if not condition:
        raise ProtocolError(code)


def unique_keys(items):
    result = {}
    for key, value in items:
        require(key not in result)
        result[key] = value
    return result


def invalid_constant(_):
    raise ProtocolError("invalid_frame")


def encode(value):
    return (json.dumps(value, separators=(",", ":"), ensure_ascii=True,
                       allow_nan=False, sort_keys=True) + "\n").encode()


def decode(line):
    require(len(line) <= MAX_FRAME, "frame_too_large")
    try:
        frame = json.loads(line.decode("utf-8"), object_pairs_hook=unique_keys,
                           parse_constant=invalid_constant)
        require(isinstance(frame, dict))
        return frame
    except (ValueError, RecursionError) as exc:
        raise ProtocolError("invalid_frame") from exc


def identifier(value, version=None):
    require(isinstance(value, str))
    try:
        parsed = uuid.UUID(value)
    except ValueError as exc:
        raise ProtocolError("invalid_id") from exc
    require(str(parsed) == value and parsed.variant == uuid.RFC_4122
            and (version is None or parsed.version == version), "invalid_id")
    return parsed


def message_expiry(value, now=None):
    now = time.time() if now is None else now
    created_ms = identifier(value, 7).int >> 80
    require(created_ms <= (now + 30) * 1000, "future_id")
    expires = created_ms / 1000 + RECEIPT_SECONDS
    require(expires > now, "expired_id")
    return expires


def validate_data(frame):
    require(frame.keys() == {"type", "device_id", "task_id", "message_id", "kind", "body"})
    identifier(frame["task_id"])
    kind, body = frame["kind"], frame["body"]
    require(isinstance(kind, str) and kind in KINDS and isinstance(body, dict))
    if kind in {"stream.open", "stream.chunk", "stream.end"}:
        identifier(body.get("stream_id"))
    if kind == "stream.chunk":
        require(body.keys() == {"stream_id", "offset", "data", "sha256"})
        require(type(body["offset"]) is int and 0 <= body["offset"] < 2**53)
        require(isinstance(body["data"], str))
        try:
            chunk = base64.b64decode(body["data"], validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ProtocolError("invalid_chunk") from exc
        require(0 < len(chunk) <= MAX_CHUNK, "invalid_chunk")
        require(body["sha256"] == hashlib.sha256(chunk).hexdigest(), "checksum_mismatch")
    if kind in {"stream.open", "stream.end"}:
        require(type(body.get("size")) is int and 0 <= body["size"] < 2**53)
    if kind == "stream.end":
        digest = body.get("sha256")
        require(isinstance(digest, str) and DIGEST_PATTERN.fullmatch(digest))
    try:
        wire = encode(frame)
    except (ValueError, RecursionError) as exc:
        raise ProtocolError("invalid_frame") from exc
    require(len(wire) <= MAX_FRAME, "frame_too_large")
    return wire
