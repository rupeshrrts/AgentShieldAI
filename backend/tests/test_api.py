import os
"""Integration tests for AgentShield API and security constraints."""
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.db.session import SessionLocal, Base, engine
from app.db.seed import init_db
from app.db.models import Organization, User, Policy, SecurityEvent, utc_now
from helpers import activated_device


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    init_db(db)
    db.close()
    with TestClient(app) as c:
        yield c


def test_health_check(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["service"] == "AgentShield"


def test_liveness_and_readiness_checks(client):
    live_res = client.get("/health/live")
    assert live_res.status_code == 200
    assert live_res.json()["status"] == "alive"

    ready_res = client.get("/health/ready")
    assert ready_res.status_code == 200
    ready_data = ready_res.json()
    assert ready_data["status"] == "ready"
    assert ready_data["database"] == "connected"


def test_admin_login_success(client):
    response = client.post(
        "/auth/login",
        json={"email": "admin@agentshield.local", "password": os.environ["INITIAL_ADMIN_PASSWORD"]},
    )
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    assert data["role"] == "ADMIN"  # platform administration is the separate internal console
    assert data["organization_id"] == "org-acme-corp-001"


def test_login_invalid_password(client):
    response = client.post(
        "/auth/login",
        json={"email": "admin@agentshield.local", "password": "WrongPassword123!"},
    )
    assert response.status_code == 401


def test_policy_crud_and_auth(client):
    # 1. Login
    login_res = client.post(
        "/auth/login",
        json={"email": "admin@agentshield.local", "password": os.environ["INITIAL_ADMIN_PASSWORD"]},
    )
    token = login_res.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # 2. Get policies
    res = client.get("/api/v1/policies", headers=headers)
    assert res.status_code == 200
    data = res.json()
    assert "policies" in data
    assert len(data["policies"]) >= 4

    # Every catalog rule has a policy
    rule_ids = {p["rule_id"] for p in data["policies"]}
    assert {"pii.credit_card", "pii.aadhaar", "pii.pan_india", "file.upload"} <= rule_ids

    # 3. A rule no detector produces is rejected (it would never match anything)
    new_policy = {
        "name": "Custom Restricted Code Rule",
        "rule_id": "code.confidential_snippet",
        "category": "SECRET",
        "site_scope": "*",
        "action": "BLOCK",
        "severity": "CRITICAL",
        "enabled": True,
    }
    create_res = client.post("/api/v1/policies", json=new_policy, headers=headers)
    assert create_res.status_code == 400

    # 4. Update a policy to MONITOR; version increments
    phone = next(p for p in data["policies"] if p["rule_id"] == "pii.phone")
    update_res = client.patch(
        f"/api/v1/policies/{phone['id']}",
        json={"action": "MONITOR", "severity": "LOW"},
        headers=headers,
    )
    assert update_res.status_code == 200
    assert update_res.json()["action"] == "MONITOR"
    assert update_res.json()["version"] == phone["version"] + 1

    # 5. Built-in rules cannot be deleted (disable instead)
    assert client.delete(f"/api/v1/policies/{phone['id']}", headers=headers).status_code == 400

    # 6. Recommended preset restores defaults and is audit-logged
    preset = client.post("/api/v1/policies/apply-preset", json={"preset": "recommended"}, headers=headers)
    assert preset.status_code == 200
    phone_after = next(p for p in preset.json()["policies"] if p["rule_id"] == "pii.phone")
    assert phone_after["action"] == "WARN"
    audit = client.get("/api/v1/org/audit-log?action=policy", headers=headers).json()
    actions = [a["action"] for a in audit["items"]]
    assert "policy.update" in actions and "policy.preset" in actions


def _admin_headers(client):
    login_res = client.post(
        "/auth/login",
        json={"email": "admin@agentshield.local", "password": os.environ["INITIAL_ADMIN_PASSWORD"]},
    )
    return {"Authorization": f"Bearer {login_res.json()['access_token']}"}


def _device_headers(client):
    headers, _info = activated_device(client)
    return headers


def test_endpoints_require_credentials(client):
    """No silent admin fallback: unauthenticated calls are rejected."""
    assert client.get("/api/v1/policies").status_code == 401
    assert client.get("/api/v1/events").status_code == 401
    assert client.get("/api/v1/metrics/summary").status_code == 401
    assert client.get("/api/v1/policies", headers={"X-Device-Key": "asd_not-a-real-key"}).status_code == 401
    assert client.get("/api/v1/policies", headers={"Authorization": "Bearer not-a-jwt"}).status_code == 401
    res = client.post(
        "/api/v1/events",
        json={"site": "chatgpt.com", "rule_id": "x", "category": "PII", "severity": "LOW",
              "action": "WARN", "outcome": "warned_and_confirmed"},
    )
    assert res.status_code == 401


def test_device_session_sync_and_scope(client):
    """An activated browser can sync policies, keywords and domains but cannot manage anything."""
    headers = _device_headers(client)

    res = client.get("/api/v1/policies", headers=headers)
    assert res.status_code == 200
    data = res.json()
    assert data["organization_id"] == "org-acme-corp-001"
    assert "PROJECT-ALPHA-CONFIDENTIAL" in data["keywords"]
    assert data["settings"]["store_clean_prompt_text"] is False

    assert client.get("/api/v1/domains", headers=headers).status_code == 200
    # Device sessions are not dashboard logins
    assert client.get("/api/v1/events", headers=headers).status_code == 401
    assert client.post("/api/v1/domains", json={"domain": "x.com"}, headers=headers).status_code == 401


def test_revoked_device_is_rejected(client):
    admin = _admin_headers(client)
    device, info = activated_device(client)
    assert client.get("/api/v1/policies", headers=device).status_code == 200

    assert client.post(f"/api/v1/org/devices/{info['device_id']}/revoke", headers=admin).status_code == 200
    assert client.get("/api/v1/policies", headers=device).status_code == 401


def test_event_ingestion_masks_secrets_and_ignores_org_override(client):
    """Secrets are masked server-side and the org comes from the device, not the payload."""
    headers, info = activated_device(client)
    event_payload = {
        "site": "chatgpt.com",
        "rule_id": "secret.api_key_like",
        "category": "SECRET",
        "severity": "HIGH",
        "action": "BLOCK",
        "outcome": "blocked",
        "user_id": "emp-test-auditor-101",
        "company_name": "Some Other Company",
        "prompt": "Explain this AWS API key: AKIAIOSFODNN7EXAMPLE",
    }
    res = client.post("/api/v1/events", json=event_payload, headers=headers)
    assert res.status_code == 201
    data = res.json()
    assert data["rule_id"] == "secret.api_key_like"
    assert data["outcome"] == "blocked"
    assert data["user_id"] == info["email"]  # from the activated account, not the payload
    assert data["organization_id"] == "org-acme-corp-001"
    assert data["application"] == "ChatGPT"
    assert "AKIAIOSFODNN7EXAMPLE" not in data["prompt"]
    assert "AKIAIOSFODNN7EXAMPLE" not in data["prompt_preview"]
    assert "[MASKED]" in data["prompt"]

    db = SessionLocal()
    try:
        assert db.query(Organization).filter(Organization.name == "Some Other Company").first() is None
    finally:
        db.close()


def test_clean_prompt_text_follows_privacy_setting(client):
    admin = _admin_headers(client)
    device = _device_headers(client)
    clean = {
        "site": "chatgpt.com", "rule_id": "general.clean_prompt", "category": "PROMPT_LOG",
        "severity": "LOW", "action": "ALLOW", "outcome": "allowed", "user_id": "emp-privacy-1",
        "prompt": "Write a haiku about autumn",
    }

    # Default: clean prompt text is not stored
    data = client.post("/api/v1/events", json=clean, headers=device).json()
    assert data["prompt"] is None
    assert "not stored" in data["prompt_preview"]

    # Admin turns it on from the dashboard
    res = client.patch("/api/v1/org/settings", json={"store_clean_prompt_text": True}, headers=admin)
    assert res.status_code == 200 and res.json()["store_clean_prompt_text"] is True
    clean["prompt"] = "Write a haiku about winter"
    data = client.post("/api/v1/events", json=clean, headers=device).json()
    assert data["prompt"] == "Write a haiku about winter"

    client.patch("/api/v1/org/settings", json={"store_clean_prompt_text": False}, headers=admin)


def test_keywords_managed_from_dashboard(client):
    admin = _admin_headers(client)
    res = client.post("/api/v1/org/keywords", json={"keyword": "PROJECT-ORION"}, headers=admin)
    assert res.status_code == 201
    kw_id = res.json()["id"]

    evaluated = client.post("/api/v1/policies/evaluate", json={"text": "Status of PROJECT-ORION?"}, headers=admin).json()
    assert evaluated["action"] == "REDACT"

    assert client.delete(f"/api/v1/org/keywords/{kw_id}", headers=admin).status_code == 204
    evaluated = client.post("/api/v1/policies/evaluate", json={"text": "Status of PROJECT-ORION?"}, headers=admin).json()
    assert evaluated["action"] == "ALLOW"


def test_viewer_cannot_manage(client):
    login = client.post("/auth/login", json={"email": "auditor@agentshield.local", "password": os.environ["DEMO_AUDITOR_PASSWORD"]})
    viewer = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert client.post("/api/v1/org/users/invite", json={"email": "x@example.com"}, headers=viewer).status_code == 403
    assert client.post("/api/v1/events/users/emp-x/action", json={"action": "SUSPEND"}, headers=viewer).status_code == 403


def test_change_password(client):
    from app.core.security import hash_password
    db = SessionLocal()
    try:
        if not db.query(User).filter(User.email == "pwchange@agentshield.local").first():
            db.add(User(id="usr-pw-001", organization_id="org-acme-corp-001", email="pwchange@agentshield.local",
                        password_hash=hash_password("OldPassword2026!"), role="ADMIN", active=True,
                        email_verified_at=utc_now()))
            db.commit()
    finally:
        db.close()

    token = client.post("/auth/login", json={"email": "pwchange@agentshield.local", "password": "OldPassword2026!"}).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    assert client.post("/auth/change-password", json={"current_password": "wrong", "new_password": "NewPassword2026!!"}, headers=headers).status_code == 400
    changed = client.post("/auth/change-password", json={"current_password": "OldPassword2026!", "new_password": "NewPassword2026!!"}, headers=headers)
    assert changed.status_code == 200 and changed.json()["access_token"]
    # The old session ended; the new one returned by the change works
    assert client.get("/auth/me", headers=headers).status_code == 401
    assert client.get("/auth/me", headers={"Authorization": f"Bearer {changed.json()['access_token']}"}).status_code == 200
    assert client.post("/auth/login", json={"email": "pwchange@agentshield.local", "password": "NewPassword2026!!"}).status_code == 200


def test_domain_rules_crud(client):
    """Verifies creating, listing, updating, and deleting blocked and allowed domains."""
    login_res = client.post(
        "/auth/login",
        json={"email": "admin@agentshield.local", "password": os.environ["INITIAL_ADMIN_PASSWORD"]},
    )
    token = login_res.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # 1. List seeded domain rules
    res = client.get("/api/v1/domains", headers=headers)
    assert res.status_code == 200
    data = res.json()
    assert data["total"] >= 5
    domains = [d["domain"] for d in data["domains"]]
    assert "ilovepdf.com" in domains
    assert "chatgpt.com" in domains

    # 2. Add custom blocked domain
    new_rule = {
        "domain": "https://malicious-shadow-ai.com/upload",
        "action": "BLOCK",
        "category": "Shadow AI",
        "description": "Block unsanctioned shadow AI site",
    }
    create_res = client.post("/api/v1/domains", json=new_rule, headers=headers)
    assert create_res.status_code == 201
    created_rule = create_res.json()
    assert created_rule["domain"] == "malicious-shadow-ai.com"
    assert created_rule["action"] == "BLOCK"
    domain_id = created_rule["id"]

    # 3. Update domain rule
    update_res = client.patch(
        f"/api/v1/domains/{domain_id}",
        json={"enabled": False},
        headers=headers,
    )
    assert update_res.status_code == 200
    assert update_res.json()["enabled"] is False

    # 4. Delete domain rule
    del_res = client.delete(f"/api/v1/domains/{domain_id}", headers=headers)
    assert del_res.status_code == 204



def test_tenant_isolation(client):
    """Ensures a user from Organization A cannot view Organization B's events."""
    db = SessionLocal()
    # Create Organization B
    org_b = db.query(Organization).filter(Organization.name == "Beta Corp").first()
    if not org_b:
        org_b = Organization(id="org-beta-002", name="Beta Corp", retention_days=30)
        db.add(org_b)
        db.flush()

    from app.core.security import hash_password
    user_b = db.query(User).filter(User.email == "user@betacorp.local").first()
    if not user_b:
        user_b = User(
            id="usr-beta-002",
            organization_id=org_b.id,
            email="user@betacorp.local",
            password_hash=hash_password("BetaCorpSecret2026!"),
            role="ADMIN",
            active=True,
            email_verified_at=utc_now(),
        )
        db.add(user_b)
        db.commit()
    db.close()

    # Login as User B
    login_res = client.post(
        "/auth/login",
        json={"email": "user@betacorp.local", "password": "BetaCorpSecret2026!"},
    )
    token_b = login_res.json()["access_token"]
    headers_b = {"Authorization": f"Bearer {token_b}"}

    # User B requests events; should only see their own org events (which is 0 initially)
    events_res = client.get("/api/v1/events", headers=headers_b)
    assert events_res.status_code == 200
    data = events_res.json()
    assert data["total"] == 0
