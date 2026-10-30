"""Near real-time sync: every enforced change bumps the revision, and browsers get every rule with its On/Off state."""
import pytest
from fastapi.testclient import TestClient

from app.core.catalog import RULE_CATALOG
from app.db.models import Organization, Policy
from app.db.seed import init_db
from app.db.session import Base, SessionLocal, engine
from app.main import app
from helpers import DeviceKeys, activate, activation_token, create_company, login, session


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    init_db(db)
    db.close()
    with TestClient(app) as c:
        yield c


def _account(client):
    """An individual account with an activated browser. Returns (org_id, admin headers, device headers)."""
    org_id, email = create_company(trial=True, account_type="INDIVIDUAL")
    admin = login(client, email)
    keys = DeviceKeys()
    res = activate(client, activation_token(client, admin), keys)
    assert res.status_code == 201, res.text
    sess = session(client, res.json()["device_id"], keys)
    assert sess.status_code == 200, sess.text
    return org_id, admin, {"Authorization": f"Bearer {sess.json()['session_token']}"}


def _revision(client, device):
    res = client.get("/api/v1/policies/revision", headers=device)
    assert res.status_code == 200, res.text
    return res.json()["revision"]


def test_revision_endpoint_needs_a_credential(client):
    assert client.get("/api/v1/policies/revision").status_code == 401


def test_every_enforced_change_bumps_the_revision(client):
    _, admin, device = _account(client)
    revision = _revision(client, device)

    # A rule switched Off in the dashboard
    policy = next(p for p in client.get("/api/v1/policies", headers=admin).json()["policies"] if p["rule_id"] == "pii.email")
    assert client.patch(f"/api/v1/policies/{policy['id']}", headers=admin, json={"enabled": False}).status_code == 200
    assert _revision(client, device) > revision
    revision = _revision(client, device)

    # Website category switched On
    assert client.patch("/api/v1/org/settings", headers=admin, json={"web_categories": {"gambling": True}}).status_code == 200
    assert _revision(client, device) > revision
    revision = _revision(client, device)

    # Website rule added, then removed
    created = client.post("/api/v1/domains", headers=admin, json={"domain": "rev-test.example", "action": "BLOCK"})
    assert created.status_code == 201, created.text
    assert _revision(client, device) > revision
    revision = _revision(client, device)
    assert client.delete(f"/api/v1/domains/{created.json()['id']}", headers=admin).status_code == 204
    assert _revision(client, device) > revision
    revision = _revision(client, device)

    # Confidential keyword added, then removed
    keyword = client.post("/api/v1/org/keywords", headers=admin, json={"keyword": "REV-TEST-CODENAME"})
    assert keyword.status_code == 201, keyword.text
    assert _revision(client, device) > revision
    revision = _revision(client, device)
    assert client.delete(f"/api/v1/org/keywords/{keyword.json()['id']}", headers=admin).status_code == 204
    assert _revision(client, device) > revision


def test_a_read_without_changes_keeps_the_revision(client):
    _, _, device = _account(client)
    first = _revision(client, device)
    assert _revision(client, device) == first
    assert client.get("/api/v1/policies", headers=device).json()["policy_revision"] == first


def test_changes_do_not_leak_between_accounts(client):
    _, admin_a, _ = _account(client)
    _, _, device_b = _account(client)
    before = _revision(client, device_b)
    policy = next(p for p in client.get("/api/v1/policies", headers=admin_a).json()["policies"] if p["rule_id"] == "pii.phone")
    assert client.patch(f"/api/v1/policies/{policy['id']}", headers=admin_a, json={"enabled": False}).status_code == 200
    assert _revision(client, device_b) == before


def test_sync_lists_every_catalog_rule_with_its_on_off_state(client):
    _, admin, device = _account(client)
    client.patch(
        f"/api/v1/policies/{next(p for p in client.get('/api/v1/policies', headers=admin).json()['policies'] if p['rule_id'] == 'pii.credit_card')['id']}",
        headers=admin,
        json={"enabled": False},
    )
    sync = client.get("/api/v1/policies", headers=device).json()
    by_rule = {p["rule_id"]: p for p in sync["policies"]}
    assert set(by_rule) == {rule["rule_id"] for rule in RULE_CATALOG}
    assert by_rule["pii.credit_card"]["enabled"] is False
    assert by_rule["secret.api_key_like"]["enabled"] is True


def test_a_missing_rule_row_is_recreated_on_sync(client):
    """Every catalog rule must be switchable: a row that went missing comes back on the next sync."""
    org_id, admin, device = _account(client)
    db = SessionLocal()
    try:
        db.query(Policy).filter(Policy.organization_id == org_id, Policy.rule_id == "file.upload").delete()
        db.commit()
    finally:
        db.close()
    before = _revision(client, device)
    sync = client.get("/api/v1/policies", headers=device).json()
    assert "file.upload" in {p["rule_id"] for p in sync["policies"]}
    assert sync["policy_revision"] > before
    db = SessionLocal()
    try:
        assert db.query(Organization).filter(Organization.id == org_id).first().policy_revision == sync["policy_revision"]
    finally:
        db.close()
