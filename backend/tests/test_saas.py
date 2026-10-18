"""Acceptance tests for SaaS phase 1: companies, free trial, licences, enforcement, platform console,
reminders, password reset and session revocation. Synthetic data only; no payments (phase 2)."""
import re
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.core import ratelimit
from app.core.entitlements import current_entitlement, utcnow
from app.core.notifications import run_reminders
from app.db.models import License, Notification, Organization, User
from app.db.seed import init_db
from app.db.session import Base, SessionLocal, engine
from app.main import app
from helpers import (
    PASSWORD,
    DeviceKeys,
    activate,
    activation_token,
    admin_headers,
    staff_headers,
    create_company,
    login,
    session,
)


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    init_db(db)
    db.close()
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _limits(monkeypatch):
    ratelimit.reset()
    # Every test client request comes from the same address; the IP cap has its own test
    monkeypatch.setattr("app.api.billing.settings.TRIAL_CLAIMS_PER_IP_30D", 10_000)
    yield


def _code(res):
    d = res.json().get("detail")
    return d.get("code") if isinstance(d, dict) else d


def _set_expiry(org_id: str, when):
    db = SessionLocal()
    try:
        for l in db.query(License).filter(License.organization_id == org_id).all():
            l.expires_at = when
        db.commit()
    finally:
        db.close()


def _connected_browser(client, org_id, email):
    keys = DeviceKeys()
    res = activate(client, activation_token(client, login(client, email)), keys)
    assert res.status_code == 201, res.text
    sess = session(client, res.json()["device_id"], keys)
    assert sess.status_code == 200, sess.text
    return {"Authorization": f"Bearer {sess.json()['session_token']}"}, res.json()["device_id"], keys, sess.json()


# --- Sign-up creates an individual account ------------------------------------------------

def test_signup_creates_own_individual_account(client, monkeypatch):
    sent = []
    monkeypatch.setattr("app.api.auth.send_email", lambda to, s, b: sent.append(b) or "log")
    email = f"founder-{uuid.uuid4().hex[:6]}@newco-{uuid.uuid4().hex[:4]}.example"
    res = client.post("/auth/signup", json={"email": email, "password": PASSWORD, "name": "Asha Rao"})
    assert res.status_code == 201
    me = res.json()
    assert me["role"] == "ADMIN" and me["account_type"] == "INDIVIDUAL" and me["organization_name"] == "Asha Rao"
    headers = {"Authorization": f"Bearer {me['access_token']}"}
    # The free trial starts only after the email is confirmed
    assert client.post("/api/v1/billing/trial", headers=headers).status_code == 409
    client.post("/auth/verify-email", json={"token": re.search(r"#verify=(asv_[\w-]+)", sent[0]).group(1)})
    assert client.post("/api/v1/billing/trial", headers=headers).status_code == 201
    # It has its own rules and no access to anyone else's data
    assert len(client.get("/api/v1/policies", headers=headers).json()["policies"]) > 0
    assert client.get("/api/v1/events", headers=headers).json()["total"] == 0
    assert client.get("/internal/api/companies", headers=headers).status_code == 401  # not a staff session


def test_tenant_isolation_between_companies(client):
    org_a, a = create_company(trial=True)
    org_b, b = create_company(trial=True)
    dev_a, *_ = _connected_browser(client, org_a, a)
    client.post("/api/v1/events", headers=dev_a, json={"site": "chatgpt.com", "rule_id": "pii.email", "category": "PII",
                                                       "severity": "LOW", "action": "WARN", "outcome": "warned_and_confirmed"})
    assert client.get("/api/v1/events", headers=login(client, a)).json()["total"] == 1
    assert client.get("/api/v1/events", headers=login(client, b)).json()["total"] == 0


# --- Free trial ------------------------------------------------------------------------------

def test_trial_claim_once_per_company(client):
    org, email = create_company()
    h = login(client, email)
    st = client.get("/api/v1/billing/status", headers=h).json()
    assert st["entitlement"]["state"] == "NONE" and st["trial"]["eligible"] is True
    res = client.post("/api/v1/billing/trial", headers=h)
    assert res.status_code == 201
    st = client.get("/api/v1/billing/status", headers=h).json()
    assert st["entitlement"]["state"] == "TRIAL_ACTIVE" and st["entitlement"]["days_left"] == 30
    again = client.post("/api/v1/billing/trial", headers=h)
    assert again.status_code == 409 and _code(again) == "TRIAL_NOT_ELIGIBLE"


def test_trial_abuse_controls(client):
    # Same Gmail mailbox written differently -> refused
    _, first = create_company(email=f"jane.doe+{uuid.uuid4().hex[:4]}@gmail.com")
    _, again = create_company(email="janedoe@gmail.com")
    assert client.post("/api/v1/billing/trial", headers=login(client, first)).status_code == 201
    assert client.post("/api/v1/billing/trial", headers=login(client, again)).status_code == 409

    # Same company domain -> refused
    domain = f"acme{uuid.uuid4().hex[:5]}.example"
    _, x = create_company(email=f"x@{domain}")
    _, y = create_company(email=f"y@{domain}")
    assert client.post("/api/v1/billing/trial", headers=login(client, x)).status_code == 201
    res = client.post("/api/v1/billing/trial", headers=login(client, y))
    assert res.status_code == 409 and domain in res.json()["detail"]["message"]

    # Disposable mailbox -> refused (sign-up refuses it too)
    _, temp = create_company(email=f"t{uuid.uuid4().hex[:4]}@mailinator.com")
    assert client.post("/api/v1/billing/trial", headers=login(client, temp)).status_code == 409


def test_trial_ip_cap(client, monkeypatch):
    monkeypatch.setattr("app.api.billing.settings.TRIAL_CLAIMS_PER_IP_30D", 1)
    db = SessionLocal()
    try:
        from app.db.models import TrialClaim
        db.query(TrialClaim).update({"claimed_at": utcnow() - timedelta(days=40)})  # earlier tests' claims are old
        db.commit()
    finally:
        db.close()
    _, a = create_company()
    _, b = create_company()
    assert client.post("/api/v1/billing/trial", headers=login(client, a)).status_code == 201
    res = client.post("/api/v1/billing/trial", headers=login(client, b))
    assert res.status_code == 409 and "network" in res.json()["detail"]["message"]


def test_concurrent_claim_cannot_create_two_trials(client, monkeypatch):
    org, email = create_company()
    h = login(client, email)
    assert client.post("/api/v1/billing/trial", headers=h).status_code == 201
    # Simulate a racing request that passed the eligibility check: the DB constraint still refuses it
    monkeypatch.setattr("app.api.billing.trial_eligibility", lambda *a, **k: (True, ""))
    assert client.post("/api/v1/billing/trial", headers=h).status_code == 409
    db = SessionLocal()
    try:
        assert db.query(License).filter(License.organization_id == org, License.kind == "TRIAL").count() == 1
    finally:
        db.close()


def test_only_company_admin_claims_trial(client):
    org, email = create_company()
    from helpers import create_account
    employee = create_account(org_id=org)
    assert client.post("/api/v1/billing/trial", headers=login(client, employee)).status_code == 403


# --- Download and activation require a licence -----------------------------------------------

def test_download_info_needs_no_licence(client):
    assert client.get("/api/v1/releases/current").status_code == 200


def test_no_licence_no_code_no_activation(client):
    org, email = create_company()
    res = client.post("/api/v1/me/activation-tokens", headers=login(client, email))
    assert res.status_code == 403 and _code(res) == "NO_LICENSE"


# --- Expiry: server time decides, on every request ---------------------------------------------

def test_trial_expiry_locks_new_and_live_sessions(client):
    org, email = create_company(trial=True)
    headers, device_id, keys, sess = _connected_browser(client, org, email)
    assert sess["entitlement"]["state"] == "TRIAL_ACTIVE"
    assert client.get("/api/v1/policies", headers=headers).status_code == 200

    _set_expiry(org, utcnow() - timedelta(minutes=1))
    live = client.get("/api/v1/policies", headers=headers)
    assert live.status_code == 403 and _code(live) == "LICENSE_EXPIRED"
    again = session(client, device_id, keys)
    assert again.status_code == 403 and _code(again) == "LICENSE_EXPIRED"
    assert client.post("/api/v1/me/activation-tokens", headers=login(client, email)).status_code == 403
    # The portal itself stays usable after expiry
    st = client.get("/api/v1/billing/status", headers=login(client, email)).json()
    assert st["entitlement"]["state"] == "EXPIRED"


def test_client_supplied_dates_are_ignored(client):
    org, email = create_company(trial=True)
    _set_expiry(org, utcnow() - timedelta(seconds=1))
    h = login(client, email)
    # Nothing the client sends can change the server's view
    res = client.post("/api/v1/me/activation-tokens", headers={**h, "Date": "Mon, 01 Jan 2024 00:00:00 GMT"})
    assert res.status_code == 403


def test_session_never_outlives_licence(client):
    org, email = create_company(trial=True)
    _set_expiry(org, utcnow() + timedelta(seconds=90))
    _, _, _, sess = _connected_browser(client, org, email)
    assert sess["expires_in"] <= 90


def test_renewal_restores_same_browser_without_reactivation(client):
    org, email = create_company(trial=True)
    headers, device_id, keys, _ = _connected_browser(client, org, email)
    _set_expiry(org, utcnow() - timedelta(minutes=1))
    assert session(client, device_id, keys).status_code == 403
    # Platform admin grants a plan (Phase 2: a verified payment does this)
    admin = staff_headers()
    res = client.post(f"/internal/api/companies/{org}/licenses", headers=admin, json={"plan_code": "annual", "reason": "offline payment"})
    assert res.status_code == 201
    again = session(client, device_id, keys)
    assert again.status_code == 200 and again.json()["entitlement"]["state"] == "SUBSCRIPTION_ACTIVE"


def test_plan_durations(client):
    from app.core.entitlements import add_months, plan_end
    from app.db.models import Plan
    db = SessionLocal()
    try:
        start = utcnow().replace(year=2026, month=1, day=31, hour=12, minute=0, second=0, microsecond=0)
        plans = {p.code: p for p in db.query(Plan).all()}
        assert (plan_end(plans["trial"], start) - start).days == 30
        assert plan_end(plans["monthly"], start).month == 2 and plan_end(plans["monthly"], start).day == 28
        assert plan_end(plans["six_month"], start) == add_months(start, 6)
        assert plan_end(plans["annual"], start).year == 2027
        assert plan_end(plans["internal"], start) is None
    finally:
        db.close()


# --- Platform admin controls ---------------------------------------------------------------------

def test_admin_trial_extension_is_audited(client):
    org, email = create_company(trial=True)
    _set_expiry(org, utcnow() - timedelta(hours=1))
    admin = staff_headers()
    lic = client.get(f"/internal/api/companies/{org}", headers=admin).json()["licences"][0]
    assert client.post(f"/internal/api/licenses/{lic['id']}/extend", headers=admin, json={"add_days": 7}).status_code == 422  # reason required
    res = client.post(f"/internal/api/licenses/{lic['id']}/extend", headers=admin, json={"add_days": 7, "reason": "Pilot needs a week more"})
    assert res.status_code == 200
    detail = client.get(f"/internal/api/companies/{org}", headers=admin).json()
    assert detail["entitlement"]["state"] == "TRIAL_ACTIVE"
    assert detail["adjustments"][0]["reason"] == "Pilot needs a week more"
    log = client.get("/internal/api/audit?action=platform.license_extend", headers=admin).json()
    assert any("Pilot needs a week more" in (e["summary"] or "") for e in log)


def test_device_limit_per_plan(client):
    org, email = create_company(trial=True)
    db = SessionLocal()
    try:
        db.query(License).filter(License.organization_id == org).update({"device_limit": 1})
        db.commit()
    finally:
        db.close()
    _connected_browser(client, org, email)
    res = activate(client, activation_token(client, login(client, email)), DeviceKeys())
    assert res.status_code == 409 and _code(res) == "DEVICE_LIMIT"


def test_revoke_licence_and_suspend_company_lock_browsers(client):
    admin = staff_headers()
    org, email = create_company(trial=True)
    headers, *_ = _connected_browser(client, org, email)
    lic = client.get(f"/internal/api/companies/{org}", headers=admin).json()["licences"][0]
    client.post(f"/internal/api/licenses/{lic['id']}/revoke", headers=admin, json={"reason": "chargeback"})
    res = client.get("/api/v1/policies", headers=headers)
    assert res.status_code == 403 and _code(res) == "LICENSE_REVOKED"

    org2, email2 = create_company(trial=True)
    headers2, *_ = _connected_browser(client, org2, email2)
    client.post(f"/internal/api/companies/{org2}/suspend", headers=admin, json={"reason": "abuse"})
    res = client.get("/api/v1/policies", headers=headers2)
    assert res.status_code == 403 and _code(res) == "ORG_SUSPENDED"
    client.post(f"/internal/api/companies/{org2}/unsuspend", headers=admin)
    assert client.get("/api/v1/policies", headers=headers2).status_code == 200


def test_internal_api_refuses_customer_admins(client):
    org, email = create_company(trial=True)
    customer_admin = login(client, email)
    for method, path in (("get", "/internal/api/companies"), ("get", "/internal/api/plans"),
                         ("patch", "/internal/api/plans/monthly"), ("post", f"/internal/api/companies/{org}/licenses"),
                         ("get", "/internal/api/metrics"), ("post", "/internal/api/jobs/run-reminders")):
        res = getattr(client, method)(path, headers=customer_admin, json={}) if method != "get" else client.get(path, headers=customer_admin)
        assert res.status_code == 401, path  # a customer token is not a staff session
    assert client.get("/internal/api/companies").status_code == 401


def test_plan_pricing_rules(client):
    admin = staff_headers()
    # Not for sale without a price
    assert client.patch("/internal/api/plans/monthly", headers=admin, json={"purchasable": True}).status_code == 400
    res = client.patch("/internal/api/plans/monthly", headers=admin, json={"price_minor": 49900, "currency": "INR", "purchasable": True, "device_limit": 5})
    assert res.status_code == 200 and res.json()["purchasable"] and res.json()["device_limit"] == 5
    assert client.patch("/internal/api/plans/trial", headers=admin, json={"purchasable": True}).status_code == 400
    shown = {p["code"]: p for p in client.get("/api/v1/billing/plans", headers=admin_headers(client)).json()}
    assert shown["monthly"]["price_minor"] == 49900 and "internal" not in shown
    client.patch("/internal/api/plans/monthly", headers=admin, json={"purchasable": False})


# --- Reminders -----------------------------------------------------------------------------------

def test_reminders_are_idempotent(client):
    org, email = create_company(trial=True)
    db = SessionLocal()
    try:
        _set_expiry(org, utcnow() + timedelta(days=6, hours=12))
        run_reminders(db)
        run_reminders(db)
        kinds = [n.kind for n in db.query(Notification).filter(Notification.organization_id == org).all()]
        assert kinds == ["expires_7d"]
        _set_expiry(org, utcnow() + timedelta(hours=20))
        run_reminders(db)
        run_reminders(db)
        _set_expiry(org, utcnow() - timedelta(hours=1))
        run_reminders(db)
        run_reminders(db)
        kinds = sorted(n.kind for n in db.query(Notification).filter(Notification.organization_id == org).all())
        assert kinds == ["expired", "expires_1d", "expires_7d"]
    finally:
        db.close()
    notes = client.get("/api/v1/billing/status", headers=login(client, email)).json()["notifications"]
    assert {n["kind"] for n in notes} == {"expired", "expires_1d", "expires_7d"}


# --- Account security ----------------------------------------------------------------------------

def test_password_reset_and_session_revocation(client, monkeypatch):
    sent = []
    monkeypatch.setattr("app.api.auth.send_email", lambda to, s, b: sent.append(b) or "log")
    org, email = create_company()
    old_session = login(client, email)
    assert client.post("/auth/forgot-password", json={"email": email}).status_code == 202
    assert client.post("/auth/forgot-password", json={"email": "nobody@nowhere.example"}).json() == \
        client.post("/auth/forgot-password", json={"email": email}).json()  # same answer either way
    token = re.search(r"#reset=(asr_[\w-]+)", sent[-1]).group(1)
    assert client.post("/auth/reset-password", json={"token": token, "password": "short"}).status_code == 422
    res = client.post("/auth/reset-password", json={"token": token, "password": "Brand-New-Pass-2026!"})
    assert res.status_code == 200
    assert client.post("/auth/reset-password", json={"token": token, "password": "Brand-New-Pass-2026!"}).status_code == 404
    assert client.get("/auth/me", headers=old_session).status_code == 401  # signed out everywhere
    assert client.post("/auth/login", json={"email": email, "password": PASSWORD}).status_code == 401
    new = login(client, email, "Brand-New-Pass-2026!")
    assert client.post("/auth/logout-all", headers=new).status_code == 204
    assert client.get("/auth/me", headers=new).status_code == 401


def test_platform_user_suspension(client):
    admin = staff_headers()
    org, email = create_company(trial=True)
    headers, *_ = _connected_browser(client, org, email)
    user_id = client.get(f"/internal/api/companies/{org}", headers=admin).json()["users"][0]["id"]
    assert client.post(f"/internal/api/users/{user_id}/suspend", headers=admin).status_code == 200
    assert client.get("/api/v1/policies", headers=headers).status_code == 401
    assert client.post("/auth/login", json={"email": email, "password": PASSWORD}).status_code == 403


def test_metrics(client):
    m = client.get("/internal/api/metrics", headers=staff_headers()).json()
    assert m["companies"] >= 2 and m["trials_claimed"] >= 1 and "TRIAL_ACTIVE" in m["by_state"]
