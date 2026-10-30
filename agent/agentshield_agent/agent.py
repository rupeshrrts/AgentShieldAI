"""The running agent: keeps a device session, syncs rules, sends events, and runs the proxy.

Authorization works like the extension's auth-state.ts: the agent starts LOCKED and is authorized only
while it holds an unexpired session the server issued. Nothing read from disk sets it. Revocation, a
disabled account, an ended licence or an unreachable server (once the session ends) lock AI sites again.
"""
import asyncio
import logging
import threading
import time
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote

from . import ca as ca_mod
from . import config, engine, keys, state
from .client import ApiError, ServerClient, Transport, urllib_transport
from .proxy import ProxyServer

log = logging.getLogger("agentshield.agent")

REACTIVATE_CODES = {"REVOKED", "DEVICE_UNKNOWN"}
REACTIVATE_EVERY = 10 * 60


def _iso(ts: Optional[float]) -> Optional[str]:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None


class Agent:
    def __init__(self, transport: Transport = urllib_transport):
        self.transport = transport
        self.snap = engine.Snapshot()
        self.conn: Optional[dict] = None          # state.json contents
        self._state_mtime: Optional[float] = None
        self.client: Optional[ServerClient] = None
        self.session_token: Optional[str] = None
        self.session_expires = 0.0
        self.last_sync = 0.0
        self.last_error = ""
        self._last_reactivate = 0.0
        self._lock = threading.Lock()
        self._events = list(state.read_json(state.QUEUE, []) or [])[-config.MAX_QUEUED_EVENTS:]
        self._recent: dict = {}
        self._wake = threading.Event()
        self._stop = threading.Event()
        self.ca = ca_mod.CertificateAuthority.load()

    # ------------------------------------------------------------ state

    def snapshot(self) -> engine.Snapshot:
        return self.snap

    def _lock_out(self, reason: str):
        self.session_token = None
        self.session_expires = 0.0
        self.snap = replace(self.snap, authorized=False, reason=reason, checks_paused=False)

    def reload_state(self, force: bool = False) -> None:
        mtime = state.mtime(state.STATE)
        if not force and mtime == self._state_mtime:
            return
        self._state_mtime = mtime
        self.conn = state.read_json(state.STATE)
        self._lock_out("AgentShield is not connected on this PC. Ask your IT team, or run AgentShield Connect with a code from the portal.")
        self.snap = engine.Snapshot(reason=self.snap.reason)   # forget the previous account's rules
        self.client = ServerClient(self.conn["api_url"], self.transport) if self.conn else None
        self.last_sync = 0.0

    def _save_conn(self):
        state.write_json(state.STATE, self.conn)
        self._state_mtime = state.mtime(state.STATE)

    # ------------------------------------------------------------ session

    def ensure_session(self) -> None:
        if not self.conn or not self.client:
            return
        now = time.time()
        if self.session_token and self.session_expires - now > config.SESSION_REFRESH_MARGIN:
            return
        try:
            res = self.client.session(self.conn["device_id"], keys.load_protected(self.conn["device_key"]))
        except ApiError as e:
            self.last_error = e.message
            if e.code in REACTIVATE_CODES and self._reactivate():
                return
            if e.code == "OFFLINE" and self.session_token and self.session_expires > now:
                return  # keep the live session until it ends
            self._lock_out(e.message)
            return
        self.session_token = res["session_token"]
        self.session_expires = now + int(res.get("expires_in") or 0)
        ent = res.get("entitlement") or {}
        self.snap = replace(self.snap, authorized=True, reason="", user_email=res.get("user_email", ""),
                            checks_paused=bool(ent.get("checks_paused")))
        self.last_error = ""
        if self.conn.get("user_email") != res.get("user_email") or self.conn.get("organization_name") != res.get("organization_name"):
            self.conn.update(user_email=res.get("user_email", ""), organization_name=res.get("organization_name", ""))
            self._save_conn()
        self.last_sync = 0.0  # sync right after a new session

    def _reactivate(self) -> bool:
        """The agent's device was removed but the PC is still connected: get a new device with the PC key
        (the same step the Windows app does for a browser). Removing the PC itself stops this."""
        if time.time() - self._last_reactivate < REACTIVATE_EVERY:
            return False
        self._last_reactivate = time.time()
        try:
            device = self.client.activate_device_for_pc(self.conn["computer_id"], keys.load_protected(self.conn["computer_key"]))
        except ApiError as e:
            self.last_error = e.message
            self._lock_out(e.message)
            return False
        self.conn.update(device)
        self._save_conn()
        self.session_token = None
        self.ensure_session()
        return bool(self.session_token)

    def check_expiry(self):
        if self.snap.authorized and time.time() >= self.session_expires:
            self._lock_out(self.last_error or "AgentShield could not renew its session with the server.")

    # ------------------------------------------------------------ server calls with the session

    def _api(self, method: str, path: str, body: Optional[dict] = None):
        try:
            return self.client.call(method, path, body, self.session_token)
        except ApiError as e:
            if e.status in (401, 403):
                self.session_token = None
                self.session_expires = 0.0
            raise

    def sync(self) -> bool:
        if not self.snap.authorized:
            return False
        try:
            data = self._api("GET", "/api/v1/policies")
            domains = (self._api("GET", "/api/v1/domains") or {}).get("domains", [])
            try:
                user_status = (self._api("GET", f"/api/v1/events/users/{quote(self.snap.user_email or 'me')}/status") or {}).get("status", "ACTIVE")
            except ApiError:
                user_status = self.snap.user_status
            ent = data.get("entitlement") or {}
            self.snap = replace(
                self.snap,
                policy_version=int(data.get("policy_version") or 0),
                policies=list(data.get("policies") or []),
                keywords=list(data.get("keywords") or []),
                settings=dict(data.get("settings") or {}),
                ai_domains=list(data.get("ai_domains") or []),
                blocked_domains=[str(d["domain"]).lower() for d in domains if d.get("action") == "BLOCK" and d.get("enabled")],
                allowed_domains=[str(d["domain"]).lower() for d in domains if d.get("action") == "ALLOW" and d.get("enabled")],
                checks_paused=bool(ent.get("checks_paused", self.snap.checks_paused)),
                user_status=user_status or "ACTIVE",
            )
            self._api("POST", "/api/v1/endpoints/heartbeat", {
                "device_id": self.conn["device_id"], "user_id": self.snap.user_email,
                "extension_version": f"agent-{config.VERSION}", "browser": "AgentShield Network Agent (all browsers)",
                "platform": "Windows", "policy_version": self.snap.policy_version, "enrollment_source": "network_agent",
            })
            self.last_sync = time.time()
            self.last_error = ""
            return True
        except ApiError as e:
            self.last_error = e.message
            return False

    # ------------------------------------------------------------ events

    def on_event(self, event: dict) -> None:
        """Called by the proxy. Duplicates within 10 s (e.g. every request of a blocked page) are dropped."""
        key = f"{event.get('site')}|{event.get('rule_id')}|{event.get('outcome')}|{event.get('prompt') or ''}"
        now = time.time()
        with self._lock:
            if now - self._recent.get(key, 0) < 10:
                return
            self._recent = {k: t for k, t in self._recent.items() if now - t < 10}
            self._recent[key] = now
            self._events.append({
                **event,
                "user_id": self.snap.user_email or None,
                "extension_version": f"agent-{config.VERSION}",
                "policy_version": self.snap.policy_version or 1,
                "client_event_id": uuid.uuid4().hex,
            })
            self._events = self._events[-config.MAX_QUEUED_EVENTS:]
            state.write_json(state.QUEUE, self._events)
        self._wake.set()

    def flush_events(self) -> None:
        if not self.session_token:
            return
        with self._lock:
            pending = list(self._events)
        sent = []
        for ev in pending:
            try:
                self._api("POST", "/api/v1/events", ev)
                sent.append(ev["client_event_id"])
            except ApiError as e:
                # 4xx other than auth / rate limiting will never succeed: drop it (like the extension)
                if 400 <= e.status < 500 and e.status not in (401, 403, 429):
                    sent.append(ev["client_event_id"])
                    continue
                break
        if sent:
            with self._lock:
                self._events = [e for e in self._events if e["client_event_id"] not in sent]
                state.write_json(state.QUEUE, self._events)

    # ------------------------------------------------------------ loop

    def tick(self) -> None:
        """One round of background work (also called directly by tests)."""
        self.reload_state()
        self.ensure_session()
        self.check_expiry()
        if self.snap.authorized and time.time() - self.last_sync > config.SYNC_SECONDS:
            self.sync()
        self.flush_events()
        self.write_status()

    def write_status(self) -> None:
        state.write_json(state.STATUS, {
            "version": config.VERSION,
            "connected": bool(self.conn),
            "authorized": self.snap.authorized,
            "reason": self.snap.reason,
            "user_email": (self.conn or {}).get("user_email", ""),
            "organization_name": (self.conn or {}).get("organization_name", ""),
            "server": (self.conn or {}).get("api_url", ""),
            "checks_paused": self.snap.checks_paused,
            "policy_version": self.snap.policy_version,
            "last_sync": _iso(self.last_sync),
            "last_error": self.last_error,
            "queued_events": len(self._events),
            "inspection_ready": self.ca is not None,
            "updated_at": _iso(time.time()),
        })

    def _background(self):
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:
                log.exception("background error")
            self._wake.wait(5)
            self._wake.clear()

    def start_worker(self) -> threading.Thread:
        """Starts the session/sync/event loop in a daemon thread and returns it.

        Used when something else owns the request handling (the mitmproxy addon), so only the
        connection housekeeping runs here. The custom proxy path uses run() instead.
        """
        worker = threading.Thread(target=self._background, name="agentshield-sync", daemon=True)
        worker.start()
        return worker

    def run(self, host: str = config.LISTEN_HOST, port: int = config.LISTEN_PORT) -> None:
        """Runs until stop() is called (the Windows service) or Ctrl+C (foreground)."""
        self.start_worker()
        asyncio.run(self._serve(host, port))

    async def _serve(self, host: str, port: int):
        proxy = ProxyServer(self.snapshot, self.ca, self.on_event)
        server = await proxy.start(host, port)
        log.info("AgentShield Network Agent listening on %s:%s", host, port)
        async with server:
            while not self._stop.is_set():
                await asyncio.sleep(0.5)
        log.info("AgentShield Network Agent stopped")

    def stop(self):
        self._stop.set()
        self._wake.set()
