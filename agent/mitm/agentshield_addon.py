"""AgentShield addon for mitmproxy — the free, self-hosted Network Agent.

mitmproxy does the proxy and TLS work; this addon only decides. It reuses the project's own logic:
  * which hosts to open (config.INTERCEPT_DOMAINS) — everything else is tunnelled, never decrypted;
  * the shared backend detector + policy evaluator (engine.check_prompt / host_verdict);
  * the device session, policy sync and event reporting (agent.Agent, which talks to the backend
    through the same /api/v1/computer and /api/v1/device flow the Windows app uses).

Run it (foreground, for development or a quick pilot):

    python -m agentshield_agent connect ASA1.xxxxxxxx      # once, pastes the portal code
    mitmdump -s agent/mitm/agentshield_addon.py --listen-host 127.0.0.1 -p 8080 \
             --set block_global=false --set connection_strategy=lazy

Then point the browser / PC at 127.0.0.1:8080 and trust mitmproxy's CA for the AI domains.
Locking the proxy and trusting the certificate for every user is done through GPO / Intune, not
here (see agent/README.md "Make it stick").

Nothing read from disk authorizes the agent: AI sites stay blocked until the backend issues a live
session (agent.Agent, mirroring the extension's fail-closed auth-state).
"""
import logging
import sys
from pathlib import Path

# Allow `mitmdump -s this_file.py` to find the agentshield_agent package next to it.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mitmproxy import http, tls  # noqa: E402

from agentshield_agent import config, engine  # noqa: E402
from agentshield_agent.agent import Agent  # noqa: E402

log = logging.getLogger("agentshield.addon")
INSPECT_METHODS = {"POST", "PUT", "PATCH"}


def _block(host: str, rule_id: str, reason: str, status: int = 403) -> http.Response:
    body = (
        '{"detail": %r, "error": {"message": %r, "type": "agentshield_blocked", "code": %r}}'
        % (f"AgentShield: {reason}", f"AgentShield: {reason}", rule_id)
    ).encode("utf-8")
    return http.Response.make(
        status, body,
        {"Content-Type": "application/json", "Cache-Control": "no-store", "X-AgentShield": rule_id or "blocked"},
    )


class AgentShield:
    def __init__(self):
        self.agent = Agent()
        self.agent.reload_state(force=True)
        self.agent.start_worker()
        log.info("AgentShield addon loaded (data dir: %s)", config.DATA_DIR)

    # --- only decrypt the AI domains; tunnel everything else untouched (privacy + stability) ---
    def tls_clienthello(self, data: tls.ClientHello):
        sni = data.client_hello.sni or ""
        if not config.is_intercepted(sni):
            data.ignore_connection = True

    def request(self, flow: http.HTTPFlow):
        host = flow.request.pretty_host
        snap = self.agent.snapshot()

        verdict = engine.host_verdict(snap, host)
        if verdict.blocked:
            if verdict.rule_id != "access.activation_required":
                self.agent.on_event({
                    "site": host[:120], "rule_id": verdict.rule_id, "category": "WEB_FILTER",
                    "severity": "MEDIUM", "action": "BLOCK", "outcome": "navigation_blocked", "prompt": verdict.reason,
                })
            flow.response = _block(host, verdict.rule_id, verdict.reason)
            return

        if flow.request.method not in INSPECT_METHODS:
            return
        ctype = flow.request.headers.get("content-type", "")
        try:
            body = flow.request.content  # mitmproxy already decompressed this
        except ValueError:
            flow.response = _block(host, "dlp.uninspectable", "This request could not be checked, so it was not sent.")
            return
        if not body or len(body) > config.MAX_INSPECT_BYTES:
            if body and len(body) > config.MAX_INSPECT_BYTES:
                textual = any(t in ctype.lower() for t in ("json", "text/", "x-www-form-urlencoded"))
                if textual:
                    flow.response = _block(host, "dlp.too_large", "This request is too large to be checked, so it was not sent.", 413)
            return

        pv = engine.check_prompt(snap, host, ctype, body, self.agent.warn)
        if pv.event:
            self.agent.on_event(pv.event)
        if not pv.forward:
            flow.response = _block(host, pv.rule_id, pv.reason)
            return
        if pv.body is not None:
            flow.request.content = pv.body  # redacted; mitmproxy fixes Content-Length / encoding


addons = [AgentShield()]
