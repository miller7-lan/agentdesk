"""Forced SSH command for issuing one expiring AgentDesk device pair."""
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

from state import MAX_DEVICES, load_devices

REGISTRY = Path('/var/lib/agentdesk-relay-registration/devices.json')
LIFETIME = 8 * 60 * 60


def main():
    raw = sys.stdin.buffer.read(1025)
    if len(raw) > 1024:
        raise ValueError('request too large')
    frame = json.loads(raw)
    identifier, bridge, orchestrator, expires = (
        frame['id'], frame['bridge'], frame['orchestrator'], frame['expires'],
    )
    now = int(time.time())
    if (not re.fullmatch(r'd[0-9a-f]{14}', identifier)
            or any(not re.fullmatch(r'[0-9a-f]{64}', digest) for digest in (bridge, orchestrator))
            or type(expires) is not int or not now < expires <= now + LIFETIME + 60):
        raise ValueError('invalid registration')
    with REGISTRY.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        registry = json.loads(REGISTRY.read_text())
        registry = {name: value for name, value in registry.items()
                    if value.get('expires_at', expires) > now}
        remote = identifier + '-orchestrator'
        registry[identifier] = {'role': 'bridge', 'peer': remote, 'token_sha256': bridge, 'expires_at': expires}
        registry[remote] = {'role': 'orchestrator', 'peer': identifier, 'token_sha256': orchestrator, 'expires_at': expires}
        if len(registry) > MAX_DEVICES:
            raise ValueError('device capacity')
        with tempfile.NamedTemporaryFile('w', dir=REGISTRY.parent, delete=False) as file:
            staged = Path(file.name)
            try:
                json.dump(registry, file)
                file.flush()
                os.fsync(file.fileno())
                os.chmod(staged, 0o640)
                load_devices(staged)
                staged.replace(REGISTRY)
            finally:
                staged.unlink(missing_ok=True)
    print('ok')


if __name__ == '__main__':
    try:
        main()
    except (KeyError, OSError, TypeError, ValueError):
        sys.exit('registration failed')
