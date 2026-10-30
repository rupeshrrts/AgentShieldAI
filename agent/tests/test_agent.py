"""AgentShield Network Agent tests.

Covers the connect flow against the real backend, the shared detection/policy decisions, prompt
extraction and redaction of AI-site request bodies, and the website verdicts — i.e. that the agent
enforces the same rules as the extension and is wire-compatible with the live API.
"""
import json

import pytest

from agentshield_agent import config, engine, inspect_body
from agentshield_agent.client import ServerClient, connect_pc, parse_activation_code


# ---------------------------------------------------------------- connect code parsing

def test_parse_asa1_code():
    api, token = parse_activation_code("ASA1." + _b64({"u": "https://x.example", "t": "asa_abc12345"}))
    assert api == "https://x.example" and token == "asa_abc12345"


def test_parse_bare_token_needs_server():
    with pytest.raises(ValueError):
        parse_activation_code("asa_abc12345")
    api, token = parse_activation_code("asa_abc12345", server_url="https://x.example/")
    assert api == "https://x.example" and token == "asa_abc12345"


def test_parse_rejects_garbage():
    for bad in ("", "hello", "ASA1.not-base64!!", "ASA1." + _b64({"u": "ftp://x", "t": "asa_x"})):
        with pytest.raises(ValueError):
            parse_activation_code(bad)


def _b64(obj) -> str:
    import base64
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")


# ---------------------------------------------------------------- real connect flow

def test_connect_pc_end_to_end(transport, trial_code):
    code, email, _org = trial_code
    conn = connect_pc(code, transport=transport, pc_name="PC-TEST")
    assert conn["api_url"] == "http://testserver"
    assert conn["computer_id"] and conn["computer_key"] and conn["device_id"] and conn["device_key"]
    assert conn["user_email"] == email

    # The device key can obtain a live session, and the session carries the organization
    client = ServerClient("http://testserver", transport)
    from agentshield_agent import keys
    res = client.session(conn["device_id"], keys.load_protected(conn["device_key"]))
    assert res["session_token"] and res["organization_name"]
    assert res["entitlement"]["state"] in ("TRIAL_ACTIVE", "ACTIVE", "FREE_ACTIVE")


def test_used_code_cannot_connect_twice(transport, trial_code):
    code, _email, _org = trial_code
    connect_pc(code, transport=transport)
    with pytest.raises(Exception):
        connect_pc(code, transport=transport)


# ---------------------------------------------------------------- shared detection / policy

def _snap(**kw) -> engine.Snapshot:
    """A synced snapshot: like the server's sync, it holds every catalog rule (recommended actions, all On);
    rules passed in `policies` replace the matching catalog rows."""
    from app.core.catalog import RULE_CATALOG
    rows = {r["rule_id"]: {"id": r["rule_id"], "rule_id": r["rule_id"], "action": r["default_action"],
                           "severity": r["default_severity"], "enabled": True} for r in RULE_CATALOG}
    for p in kw.pop("policies", []):
        rows[p["rule_id"]] = p
    base = dict(authorized=True, user_status="ACTIVE", settings={"store_violation_prompt_text": True}, policies=list(rows.values()))
    base.update(kw)
    return engine.Snapshot(**base)


def test_nothing_is_judged_until_the_rules_have_synced():
    """No built-in defaults: with an incomplete rule set the prompt is held (fail closed), like the extension."""
    pv = engine.check_prompt(engine.Snapshot(authorized=True), "chatgpt.com", "application/json",
                             _json_body("what is the capital of France?"), engine.WarnMemory())
    assert not pv.forward and pv.rule_id == "access.rules_loading"


def test_switched_off_rule_is_not_enforced():
    snap = _snap(policies=[{"id": "x", "rule_id": "secret.api_key_like", "action": "BLOCK", "severity": "HIGH", "enabled": False}])
    pv = engine.check_prompt(snap, "chatgpt.com", "application/json",
                             _json_body("my key is sk-live-ABCDEFGH1234567890abcd"), engine.WarnMemory())
    assert pv.forward


def _json_body(text: str) -> bytes:
    return json.dumps({"messages": [{"role": "user", "content": {"parts": [text]}}]}).encode()


def test_secret_is_blocked():
    pv = engine.check_prompt(_snap(), "chatgpt.com", "application/json",
                             _json_body("my key is sk-live-ABCDEFGH1234567890abcd"), engine.WarnMemory())
    assert not pv.forward and pv.event["action"] == "BLOCK"


def test_clean_prompt_passes():
    pv = engine.check_prompt(_snap(), "chatgpt.com", "application/json",
                             _json_body("what is the capital of France?"), engine.WarnMemory())
    assert pv.forward and pv.body is None


def test_pii_warn_then_resend_confirms():
    warn = engine.WarnMemory()
    body = _json_body("email me at john.doe@example.com please")
    first = engine.check_prompt(_snap(), "claude.ai", "application/json", body, warn)
    assert not first.forward and "again" in first.reason.lower()
    second = engine.check_prompt(_snap(), "claude.ai", "application/json", body, warn)
    assert second.forward


def test_restricted_keyword_is_redacted_in_body():
    snap = _snap(policies=[{"id": "1", "rule_id": "restricted.keyword", "action": "REDACT", "severity": "MEDIUM", "enabled": True}],
                 keywords=["PROJECT-ORION"])
    body = _json_body("summarise PROJECT-ORION for me")
    pv = engine.check_prompt(snap, "chatgpt.com", "application/json", body, engine.WarnMemory())
    assert pv.forward and pv.body is not None
    assert b"PROJECT-ORION" not in pv.body and b"REDACTED" in pv.body
    # Still valid JSON with the structure intact
    assert json.loads(pv.body)["messages"][0]["content"]["parts"][0].startswith("summarise [REDACTED")


def test_checks_paused_lets_everything_through():
    pv = engine.check_prompt(_snap(checks_paused=True), "chatgpt.com", "application/json",
                             _json_body("sk-live-ABCDEFGH1234567890abcd"), engine.WarnMemory())
    assert pv.forward and pv.body is None and pv.event is None


def test_suspended_user_is_blocked():
    pv = engine.check_prompt(_snap(user_status="SUSPENDED"), "chatgpt.com", "application/json",
                             _json_body("hello"), engine.WarnMemory())
    assert not pv.forward and pv.rule_id == "enterprise.user_suspended"


def test_non_prompt_body_is_ignored():
    pv = engine.check_prompt(_snap(), "chatgpt.com", "application/json",
                             json.dumps({"telemetry": {"fps": 60}}).encode(), engine.WarnMemory())
    assert pv.forward and pv.event is None


# ---------------------------------------------------------------- website verdicts

def test_ai_site_blocked_until_authorized():
    assert engine.host_verdict(_snap(authorized=False), "chatgpt.com").blocked
    assert not engine.host_verdict(_snap(authorized=True), "chatgpt.com").blocked


def test_explicit_blocked_domain():
    v = engine.host_verdict(_snap(blocked_domains=["evil.example"]), "www.evil.example")
    assert v.blocked and v.rule_id == "dlp.domain.blocked"


def test_unapproved_ai_blocked_when_enabled():
    snap = _snap(settings={"block_unapproved_ai": True}, ai_domains=["character.ai"])
    assert engine.host_verdict(snap, "character.ai").blocked
    # An explicitly allowed one is let through even so
    snap2 = _snap(settings={"block_unapproved_ai": True}, ai_domains=["character.ai"], allowed_domains=["character.ai"])
    assert not engine.host_verdict(snap2, "character.ai").blocked


def test_non_intercepted_site_is_not_touched():
    assert not engine.host_verdict(_snap(), "bank.example").blocked
    assert not config.is_intercepted("bank.example")


# ---------------------------------------------------------------- body extraction / rewrite

def test_form_body_gemini_style():
    payload = json.dumps([[["prompt", "tell me a secret: sk-live-ABCDEFGH1234567890abcd"]]])
    body = f"f.req={payload}".encode()
    parsed = inspect_body.parse("gemini.google.com", "application/x-www-form-urlencoded", body)
    assert "sk-live" in parsed.text
    out = inspect_body.rewrite(parsed, lambda t: t.replace("sk-live-ABCDEFGH1234567890abcd", "[X]"))
    assert b"sk-live" not in out


def test_plain_text_body():
    parsed = inspect_body.parse("claude.ai", "text/plain", b"hello world")
    assert parsed.text == "hello world"
    assert inspect_body.rewrite(parsed, lambda t: t.upper()) == b"HELLO WORLD"


def test_multipart_is_not_inspected():
    parsed = inspect_body.parse("chatgpt.com", "multipart/form-data; boundary=x", b"--x\r\n...binary...")
    assert parsed.leaves == []


# ---------------------------------------------------------------- the running agent (session + sync + events)

def test_agent_authorizes_syncs_and_flushes_events(transport, trial_code, agent_dir):
    from agentshield_agent import state
    from agentshield_agent.agent import Agent

    code, email, _org = trial_code
    conn = connect_pc(code, transport=transport, pc_name="PC-TEST")
    state.write_json(state.STATE, conn)

    agent = Agent(transport=transport)
    agent.tick()                       # reload state -> session -> sync -> heartbeat -> status
    snap = agent.snapshot()
    assert snap.authorized and snap.user_email == email
    assert agent.session_token and snap.user_status == "ACTIVE"
    # ai_domains and settings arrived from the real /policies response
    assert isinstance(snap.settings, dict)

    # A block event queued by the proxy is sent to the real /events endpoint on the next tick
    agent.on_event({"site": "chatgpt.com", "rule_id": "secret.api_key_like", "category": "SECRET",
                    "severity": "HIGH", "action": "BLOCK", "outcome": "blocked", "prompt": "[REDACTED:SECRET]"})
    assert len(agent._events) == 1
    agent.flush_events()
    assert agent._events == []

    status = state.read_json(state.STATUS)
    assert status["authorized"] is True and status["connected"] is True


def test_agent_stays_locked_without_a_connection(agent_dir, transport):
    from agentshield_agent.agent import Agent
    agent = Agent(transport=transport)
    agent.tick()
    assert not agent.snapshot().authorized
    # AI sites blocked, non-AI untouched, even though nothing is connected
    assert engine.host_verdict(agent.snapshot(), "chatgpt.com").blocked
    assert not engine.host_verdict(agent.snapshot(), "bank.example").blocked
