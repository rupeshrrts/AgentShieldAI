"""Talks to the AgentShield server with the same API the extension and the Windows app use.

Connecting a PC (`connect_pc`) reuses the AgentShield Windows app flow (backend api/computers.py):
  1. /api/v1/computer/activate      portal code + new PC key -> the PC holds one device slot
  2. /api/v1/computer/browser-code  signed by the PC key -> single-use code for one "browser"
  3. /api/v1/device/activate        that code + new device key -> the agent is a device of the PC
After that the agent signs a challenge for each 15-minute device session (/api/v1/device/session)
and uses it for /policies, /domains, /events and /endpoints/heartbeat exactly like the extension.
No shared or organization key is ever stored: the organization comes from the server's session.
"""
import base64
import json
import platform
import socket
import urllib.error
import urllib.request
from typing import Callable, Optional, Tuple

from . import config, keys

AGENT_BROWSER_LABEL = f"AgentShield Network Agent {config.VERSION} (all browsers)"
ACTIVATION_PREFIX = "ASA1."

Transport = Callable[[str, str, Optional[dict], dict], Tuple[int, object]]


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def urllib_transport(method: str, url: str, body: Optional[dict], headers: dict) -> Tuple[int, object]:
    # ProxyHandler({}): the agent's own calls never go through the system proxy, which is the agent itself
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Accept": "application/json", **headers})
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=20) as res:
            raw = res.read()
            return res.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw) if raw else None
        except ValueError:
            return e.code, None


def parse_activation_code(code: str, server_url: Optional[str] = None) -> Tuple[str, str]:
    """`ASA1.<base64url {u, t}>` from the portal, or a bare `asa_…` token together with server_url."""
    raw = "".join((code or "").split()).strip("\"'`,")
    if raw.startswith(ACTIVATION_PREFIX):
        b64 = raw[len(ACTIVATION_PREFIX):]
        try:
            data = json.loads(base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4)).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ValueError("This connect code is not valid. Copy it again from the portal.")
        api_url, token = str(data.get("u") or "").strip().rstrip("/"), str(data.get("t") or "").strip()
    elif raw.startswith("asa_"):
        api_url, token = (server_url or "").strip().rstrip("/"), raw
    else:
        raise ValueError("This connect code is not valid. Copy it again from the portal.")
    if not api_url.lower().startswith(("http://", "https://")) or not token.startswith("asa_"):
        raise ValueError("This connect code is not valid (no server address). Copy it again from the portal.")
    return api_url, token


class ServerClient:
    def __init__(self, api_url: str, transport: Transport = urllib_transport):
        self.api_url = api_url.rstrip("/")
        self.transport = transport

    def call(self, method: str, path: str, body: Optional[dict] = None, token: Optional[str] = None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            status, data = self.transport(method, self.api_url + path, body, headers)
        except (OSError, urllib.error.URLError) as e:
            raise ApiError(0, "OFFLINE", f"Cannot reach the AgentShield server ({e}).")
        if status >= 400:
            detail = data.get("detail") if isinstance(data, dict) else None
            if isinstance(detail, dict):
                raise ApiError(status, str(detail.get("code") or status), str(detail.get("message") or detail))
            raise ApiError(status, str(status), str(detail or f"HTTP {status}"))
        return data

    # ------------------------------------------------------------ PC and device keys

    def _signed_pc(self, path: str, computer_id: str, pc_key, browser: Optional[str] = None):
        nonce = self.call("POST", "/api/v1/computer/challenge", {"computer_id": computer_id})["nonce"]
        body = {"computer_id": computer_id, "nonce": nonce, "signature": keys.sign_b64(pc_key, nonce)}
        if browser:
            body["browser"] = browser
        return self.call("POST", path, body)

    def activate_device_for_pc(self, computer_id: str, pc_key) -> dict:
        """New single-use code from the PC key -> a new device (own key) of this PC."""
        code = self._signed_pc("/api/v1/computer/browser-code", computer_id, pc_key, AGENT_BROWSER_LABEL)["token"]
        dev_key = keys.new_key()
        res = self.call("POST", "/api/v1/device/activate", {
            "activation_token": code, "public_key": keys.public_b64(dev_key),
            "browser": AGENT_BROWSER_LABEL, "platform": _platform(),
        })
        return {"device_id": res["device_id"], "device_status": res["status"], "device_key": keys.dump_protected(dev_key)}

    def session(self, device_id: str, dev_key) -> dict:
        nonce = self.call("POST", "/api/v1/device/challenge", {"device_id": device_id})["nonce"]
        return self.call("POST", "/api/v1/device/session",
                         {"device_id": device_id, "nonce": nonce, "signature": keys.sign_b64(dev_key, nonce)})

    def pc_status(self, computer_id: str, pc_key) -> dict:
        return self._signed_pc("/api/v1/computer/status", computer_id, pc_key)

    def pc_deactivate(self, computer_id: str, pc_key) -> None:
        self._signed_pc("/api/v1/computer/deactivate", computer_id, pc_key)


def _platform() -> str:
    return f"{platform.system()} {platform.release()}".strip()[:60]


def connect_pc(code: str, server_url: Optional[str] = None, transport: Transport = urllib_transport,
               pc_name: Optional[str] = None) -> dict:
    """Connects this PC with a portal code. Returns the new state (to be saved as state.json)."""
    api_url, token = parse_activation_code(code, server_url)
    client = ServerClient(api_url, transport)
    pc_key = keys.new_key()
    pc = client.call("POST", "/api/v1/computer/activate", {
        "activation_token": token, "public_key": keys.public_b64(pc_key),
        "name": (pc_name or socket.gethostname())[:120], "platform": _platform(),
    })
    try:
        device = client.activate_device_for_pc(pc["computer_id"], pc_key)
    except Exception:
        # Do not leave a half-connected PC holding a device slot
        try:
            client.pc_deactivate(pc["computer_id"], pc_key)
        except Exception:
            pass
        raise
    return {
        "api_url": api_url,
        "computer_id": pc["computer_id"],
        "computer_key": keys.dump_protected(pc_key),
        "user_email": pc.get("user_email", ""),
        "organization_name": pc.get("organization_name", ""),
        **device,
    }
