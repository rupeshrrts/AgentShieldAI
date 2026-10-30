"""Files in the agent's data folder.

state.json   the PC connection: server address, PC id + key, device id + key (keys DPAPI-protected).
             Written by `connect` / `disconnect`; the service reloads it when it changes.
status.json  what the running service reports (authorized, last sync, errors) for `status`.
queue.json   events that could not be sent yet (masked like the extension's queue).
ca/          the local root certificate (public) and its DPAPI-protected key.

Nothing read from these files makes the agent authorized: only a session the server issues does.
"""
import json
import os
from pathlib import Path
from typing import Any, Optional

from . import config


def data_dir() -> Path:
    d = Path(os.environ.get("AGENTSHIELD_AGENT_DIR") or config.DATA_DIR)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _path(name: str) -> Path:
    return data_dir() / name


def read_json(name: str, default: Any = None) -> Any:
    try:
        return json.loads(_path(name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(name: str, value: Any) -> None:
    target = _path(name)
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2), encoding="utf-8")
    os.replace(tmp, target)


def remove(name: str) -> None:
    try:
        _path(name).unlink()
    except FileNotFoundError:
        pass


def mtime(name: str) -> Optional[float]:
    try:
        return _path(name).stat().st_mtime
    except OSError:
        return None


STATE = "state.json"
STATUS = "status.json"
QUEUE = "queue.json"
