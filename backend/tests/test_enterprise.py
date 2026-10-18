import os
"""Tests for enterprise features: endpoints, audit log, export, monitor mode, shadow-AI settings."""
import csv
import io
import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.db.seed import init_db
from app.db.session import Base, SessionLocal, engine
from app.main import app
from helpers import activated_device


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    init_db(db)
    db.close()
    with TestClient(app) as c:
        yield c


def _admin(client):
    token = client.post("/auth/login", json={"email": "admin@agentshield.local", "password": os.environ["INITIAL_ADMIN_PASSWORD"]}).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def _device(client):
    headers, _info = activated_device(client)
    return headers


def test_heartbeat_registers_endpoint_and_employee(client):
    device, info = activated_device(client, email="quiet.employee@example.com")
    hb = {
        "device_id": "install-test-0001",       # ignored: the authorized device ID is used
        "user_id": "someone.else@example.com",  # ignored: the device's account is used
        "extension_version": "1.2.0",
        "browser": "Google Chrome 140",
        "platform": "Windows",
        "policy_version": 1,
        "enrollment_source": "enrollment_code",
    }
    assert client.post("/api/v1/endpoints/heartbeat", json=hb, headers=device).status_code == 204
    # A second heartbeat updates the same endpoint rather than creating another
    assert client.post("/api/v1/endpoints/heartbeat", json=hb, headers=device).status_code == 204

    admin = _admin(client)
    summary = client.get("/api/v1/endpoints", headers=admin).json()
    rows = [e for e in summary["items"] if e["device_id"] == info["device_id"]]
    assert len(rows) == 1
    assert rows[0]["status"] == "ONLINE"
    assert rows[0]["user_id"] == "quiet.employee@example.com"
    assert not [e for e in summary["items"] if e["device_id"] == "install-test-0001"]
    assert summary["online"] >= 1

    # Employees with an enrolled browser but no events still appear in the employee list
    users = client.get("/api/v1/events/users/summary", headers=admin).json()
    assert any(u["user_id"] == "quiet.employee@example.com" and u["total_prompts"] == 0 for u in users)


def test_heartbeat_requires_device_key(client):
    hb = {"device_id": "install-test-0002"}
    assert client.post("/api/v1/endpoints/heartbeat", json=hb).status_code == 401
    assert client.post("/api/v1/endpoints/heartbeat", json=hb, headers=_admin(client)).status_code == 403


def test_failed_login_is_audited(client):
    client.post("/auth/login", json={"email": "admin@agentshield.local", "password": "not-the-password"})
    log = client.get("/api/v1/org/audit-log?action=login.failed", headers=_admin(client)).json()
    assert log["total"] >= 1
    assert all("not-the-password" not in (e["details"] or "") + (e["summary"] or "") for e in log["items"])


def test_me_flags_default_password(client):
    # An account still using a password published by an older release is flagged
    from app.api.auth import _KNOWN_DEFAULT_PASSWORDS
    from app.core.security import hash_password
    from app.db.models import User
    from app.db.session import SessionLocal

    email = f"legacy-{uuid.uuid4().hex[:8]}@example.com"
    db = SessionLocal()
    try:
        db.add(User(organization_id="org-acme-corp-001", email=email, password_hash=hash_password(_KNOWN_DEFAULT_PASSWORDS[0]),
                    role="ADMIN", active=True))
        db.commit()
    finally:
        db.close()
    token = client.post("/auth/login", json={"email": email, "password": _KNOWN_DEFAULT_PASSWORDS[0]}).json()["access_token"]
    assert client.get("/auth/me", headers={"Authorization": f"Bearer {token}"}).json()["using_default_password"] is True
    assert client.get("/auth/me", headers=_admin(client)).json()["using_default_password"] is False


def test_monitor_event_and_justification_are_stored(client):
    device = _device(client)
    res = client.post("/api/v1/events", headers=device, json={
        "site": "claude.ai", "rule_id": "pii.email", "category": "PII", "severity": "MEDIUM",
        "action": "WARN", "outcome": "warned_and_confirmed", "user_id": "emp-justify",
        "prompt": "reply to demo.user@example.com", "justification": "Customer asked for a reply",
    })
    assert res.status_code == 201
    assert res.json()["justification"] == "Customer asked for a reply"
    assert res.json()["application"] == "Claude"

    res = client.post("/api/v1/events", headers=device, json={
        "site": "chatgpt.com", "rule_id": "pii.phone", "category": "PII", "severity": "LOW",
        "action": "MONITOR", "outcome": "monitored", "user_id": "emp-justify",
    })
    assert res.status_code == 201
    metrics = client.get("/api/v1/metrics/summary", headers=_admin(client)).json()
    assert metrics["monitored_count"] >= 1

    # Overview chart data: per-site counts (top 8 + Other) and 14 UTC days, today last
    assert metrics["site_distribution"].get("chatgpt.com", 0) >= 1
    assert len(metrics["site_distribution"]) <= 9
    days = metrics["daily_events"]
    assert len(days) == 14 and days[-1]["day"] == datetime.now(timezone.utc).date().isoformat()
    assert days[-1]["warned"] >= 1 and days[-1]["other"] >= 1
    assert sum(d["blocked"] + d["warned"] + d["redacted"] + d["other"] for d in days) <= metrics["total_events"]


def test_csv_export_is_safe_and_audited(client):
    device = _device(client)
    client.post("/api/v1/events", headers=device, json={
        "site": "chatgpt.com", "rule_id": "secret.api_key_like", "category": "SECRET", "severity": "HIGH",
        "action": "BLOCK", "outcome": "blocked", "justification": "=HYPERLINK(\"http://evil\")",
        "prompt": "key sk-demo-EXPORTTEST1234567",
    })
    admin = _admin(client)
    res = client.get("/api/v1/events/export.csv?rule_id=secret.api_key_like", headers=admin)
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/csv")
    rows = list(csv.reader(io.StringIO(res.text)))
    assert rows[0][0] == "occurred_at"
    body = res.text
    assert "EXPORTTEST1234567" not in body          # secret masked
    assert "'=HYPERLINK" in body                    # formula injection neutralized
    log = client.get("/api/v1/org/audit-log?action=events.export", headers=admin).json()
    assert log["total"] >= 1


def test_unapproved_ai_setting_reaches_extension(client):
    admin = _admin(client)
    device = _device(client)
    sync = client.get("/api/v1/policies", headers=device).json()
    assert sync["settings"]["block_unapproved_ai"] is False
    assert "chat.deepseek.com" in sync["ai_domains"]

    res = client.patch("/api/v1/org/settings", json={"block_unapproved_ai": True}, headers=admin)
    assert res.status_code == 200 and res.json()["block_unapproved_ai"] is True
    assert client.get("/api/v1/policies", headers=device).json()["settings"]["block_unapproved_ai"] is True

    log = client.get("/api/v1/org/audit-log?action=settings", headers=admin).json()
    assert any("block_unapproved_ai" in (e["summary"] or "") for e in log["items"])
    client.patch("/api/v1/org/settings", json={"block_unapproved_ai": False}, headers=admin)


@pytest.mark.parametrize("bad", ["not a domain", "localhost", "http://", "*.*", "a b.com"])
def test_domain_validation(client, bad):
    assert client.post("/api/v1/domains", json={"domain": bad, "action": "BLOCK"}, headers=_admin(client)).status_code == 400


def test_wildcard_domain_is_normalized(client):
    res = client.post("/api/v1/domains", json={"domain": "*.example-converter.com", "action": "BLOCK"}, headers=_admin(client))
    assert res.status_code == 201
    assert res.json()["domain"] == "example-converter.com"


def test_viewer_can_read_audit_log_but_not_change_settings(client):
    token = client.post("/auth/login", json={"email": "auditor@agentshield.local", "password": os.environ["DEMO_AUDITOR_PASSWORD"]}).json()["access_token"]
    viewer = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/v1/org/audit-log", headers=viewer).status_code == 200
    assert client.patch("/api/v1/org/settings", json={"block_unapproved_ai": True}, headers=viewer).status_code == 403
    assert client.post("/api/v1/policies/apply-preset", json={"preset": "strict"}, headers=viewer).status_code == 403
