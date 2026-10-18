"""Free forever (individual accounts with a confirmed email) and referrals (2.3).

Run with DATABASE_URL pointing at a throwaway SQLite file (see AGENTS.md).
"""
import re
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.core import ratelimit
from app.core.config import settings
from app.core.entitlements import current_entitlement, utcnow
from app.db.models import CreditLedger, License, Notification, Organization, Plan, Referral, UsageDaily, User
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


@pytest.fixture(autouse=True)
def _limits(monkeypatch):
    ratelimit.reset()
    monkeypatch.setattr(settings, "TRIAL_CLAIMS_PER_IP_30D", 100000)
    yield


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def state(org_id):
    db = SessionLocal()
    try:
        return current_entitlement(db, org_id)
    finally:
        db.close()


def set_free(limit=300, device_limit=1):
    db = SessionLocal()
    try:
        db.query(Plan).filter(Plan.code == "free").update({"check_limit": limit, "device_limit": device_limit})
        db.commit()
    finally:
        db.close()


def set_verified(email, verified: bool):
    db = SessionLocal()
    try:
        db.query(User).filter(User.email == email).update({"email_verified_at": utcnow() if verified else None})
        db.commit()
    finally:
        db.close()


def connect(client, email):
    """Activates one browser. Returns (device session headers, device_id, keys)."""
    user = login(client, email)
    keys = DeviceKeys()
    res = activate(client, activation_token(client, user), keys)
    assert res.status_code == 201, res.text
    sess = session(client, res.json()["device_id"], keys)
    assert sess.status_code == 200, sess.text
    return _bearer(sess.json()["session_token"]), res.json()["device_id"], keys


def prompt_event() -> dict:
    return {"site": "chatgpt.com", "rule_id": "general.clean_prompt", "category": "PROMPT_LOG", "severity": "LOW",
            "action": "ALLOW", "outcome": "allowed", "client_event_id": uuid.uuid4().hex}


def add_usage(org_id, checks):
    db = SessionLocal()
    try:
        db.add(UsageDaily(organization_id=org_id, user_email="x", day=utcnow().strftime("%Y-%m-%d"), prompt_checks=checks,
                          credit_checks=0, blocked=0, warned=0, redacted=0))
        db.commit()
    finally:
        db.close()


# --- Free plan ---------------------------------------------------------------------------------

def test_free_plan_is_seeded_and_not_for_sale(client):
    db = SessionLocal()
    try:
        plan = db.query(Plan).filter(Plan.code == "free").first()
        assert plan.kind == "FREE" and plan.check_limit == 300 and plan.device_limit == 1 and not plan.purchasable
    finally:
        db.close()


def test_verified_individual_gets_free_plan(client):
    org_id, email = create_company(account_type="INDIVIDUAL")
    ent = state(org_id)
    assert ent.state == "FREE_ACTIVE" and ent.check_limit == 300 and ent.device_limit == 1 and ent.expires_at is None
    assert ent.license is None
    status = client.get("/api/v1/billing/status", headers=login(client, email)).json()
    e = status["entitlement"]
    assert e["state"] == "FREE_ACTIVE" and e["plan_code"] == "free" and e["checks_paused"] is False and e["resets_at"]
    # No licence row is created, so the 30-day trial can still be claimed once
    assert status["trial"]["eligible"] is True
    # One browser on the free plan
    connect(client, email)
    keys = DeviceKeys()
    res = activate(client, activation_token(client, login(client, email)), keys)
    assert res.status_code == 409 and res.json()["detail"]["code"] == "DEVICE_LIMIT"


def test_free_plan_must_be_chosen_first(client, monkeypatch):
    monkeypatch.setattr(settings, "EMAIL_VERIFICATION_REQUIRED", True)
    org_id, email = create_company(account_type="INDIVIDUAL", free=False)
    user = login(client, email)
    # Confirmed, but no plan chosen yet: no access, no download link, no activation code
    assert state(org_id).state == "NONE"
    status = client.get("/api/v1/billing/status", headers=user).json()
    assert status["free"] == {"eligible": True, "reason": "", "started_at": None}
    assert client.post("/api/v1/me/activation-tokens", headers=user).status_code == 403
    assert client.post("/api/v1/me/download-link", headers=user, json={"file": "agentshield-extension.zip"}).status_code == 403
    # Choosing the Free plan gives access (audited); choosing it twice is refused
    res = client.post("/api/v1/billing/free", headers=user)
    assert res.status_code == 201 and res.json()["state"] == "FREE_ACTIVE"
    assert client.get("/api/v1/billing/status", headers=user).json()["free"]["started_at"]
    assert client.post("/api/v1/billing/free", headers=user).status_code == 409
    assert client.post("/api/v1/me/activation-tokens", headers=user).status_code == 201
    # An unconfirmed owner cannot choose it, and company workspaces have no Free plan
    _, unconfirmed = create_company(account_type="INDIVIDUAL", free=False)
    set_verified(unconfirmed, False)
    res = client.post("/api/v1/billing/free", headers=login(client, unconfirmed))
    assert res.status_code == 409 and "Confirm your email" in res.json()["detail"]["message"]
    _, company = create_company(free=False)
    assert client.post("/api/v1/billing/free", headers=login(client, company)).status_code == 409
    assert client.post("/api/v1/billing/free").status_code == 401


def test_unverified_individual_has_no_free_plan(client):
    org_id, email = create_company(account_type="INDIVIDUAL")
    set_verified(email, False)
    assert state(org_id).state == "NONE"
    res = client.post("/api/v1/me/activation-tokens", headers=login(client, email))
    assert res.status_code == 403 and res.json()["detail"]["code"] == "NO_LICENSE"


def test_company_workspace_is_unaffected(client):
    org_id, _ = create_company()  # COMPANY, confirmed email, no licence
    assert state(org_id).state == "NONE"


def test_free_tier_can_be_switched_off(client, monkeypatch):
    org_id, _ = create_company(account_type="INDIVIDUAL")
    monkeypatch.setattr(settings, "FREE_TIER_ENABLED", False)
    assert state(org_id).state == "NONE"


def test_free_limit_pauses_checks_but_keeps_browser_connected(client):
    org_id, email = create_company(account_type="INDIVIDUAL")
    device, device_id, keys = connect(client, email)
    add_usage(org_id, 299)
    assert client.post("/api/v1/events", headers=device, json=prompt_event()).status_code == 201
    ent = state(org_id)
    assert ent.checks_this_month == 300 and ent.state == "FREE_PAUSED"
    # The device session keeps working: website controls and sync continue, the sync says checks are paused
    res = client.get("/api/v1/policies", headers=device)
    assert res.status_code == 200, res.text
    assert res.json()["entitlement"]["state"] == "FREE_PAUSED" and res.json()["entitlement"]["checks_paused"] is True
    assert client.get("/api/v1/domains", headers=device).status_code == 200
    # A new session is still issued (the browser resumes by itself on the 1st), with no end date
    sess = session(client, device_id, keys)
    assert sess.status_code == 200, sess.text
    assert sess.json()["entitlement"]["state"] == "FREE_PAUSED" and sess.json()["expires_in"] == settings.DEVICE_SESSION_MINUTES * 60
    assert sess.json()["entitlement"]["resets_at"].startswith(("20",))
    # Activation codes can still be created
    assert client.post("/api/v1/me/activation-tokens", headers=login(client, email)).status_code == 201
    # Usage page shows the paused state
    usage = client.get("/api/v1/usage", headers=login(client, email)).json()
    assert usage["entitlement"]["checks_paused"] is True and usage["entitlement"]["check_limit"] == 300


def test_free_limit_then_credits(client):
    set_free(limit=2)
    try:
        org_id, email = create_company(account_type="INDIVIDUAL", credits=1)
        device, _, _ = connect(client, email)
        for _ in range(2):
            assert client.post("/api/v1/events", headers=device, json=prompt_event()).status_code == 201
        ent = state(org_id)
        assert ent.state == "FREE_ACTIVE" and ent.pay_with_credits is True
        assert client.post("/api/v1/events", headers=device, json=prompt_event()).status_code == 201
        db = SessionLocal()
        try:
            org = db.query(Organization).filter(Organization.id == org_id).first()
            credit_checks = sum(r.credit_checks for r in db.query(UsageDaily).filter(UsageDaily.organization_id == org_id))
            assert org.credit_balance == 0 and credit_checks == 1
        finally:
            db.close()
        assert state(org_id).state == "FREE_PAUSED"
        assert client.get("/api/v1/policies", headers=device).status_code == 200
    finally:
        set_free()


def test_credits_keep_pay_as_you_go_browser_allowance(client):
    org_id, _ = create_company(account_type="INDIVIDUAL", credits=5)
    ent = state(org_id)
    assert ent.state == "FREE_ACTIVE" and ent.device_limit == max(1, settings.CREDITS_DEVICE_LIMIT)


def test_own_monthly_limit_pauses_free_checks(client):
    org_id, email = create_company(account_type="INDIVIDUAL")
    device, _, _ = connect(client, email)
    user = login(client, email)
    assert client.patch("/api/v1/usage/settings", headers=user, json={"monthly_check_cap": 1}).status_code == 200
    assert client.post("/api/v1/events", headers=device, json=prompt_event()).status_code == 201
    assert state(org_id).state == "FREE_PAUSED"
    assert client.get("/api/v1/policies", headers=device).status_code == 200
    assert client.patch("/api/v1/usage/settings", headers=user, json={"monthly_check_cap": None}).status_code == 200
    assert state(org_id).state == "FREE_ACTIVE"


def test_trial_still_claimable_then_expiry_moves_to_free(client):
    from app.core.notifications import run_reminders

    org_id, email = create_company(account_type="INDIVIDUAL")
    user = login(client, email)
    assert client.post("/api/v1/billing/trial", headers=user).status_code == 201
    assert state(org_id).state == "TRIAL_ACTIVE"
    device, _, _ = connect(client, email)
    db = SessionLocal()
    try:
        db.query(License).filter(License.organization_id == org_id).update({"expires_at": utcnow() - timedelta(minutes=1)})
        db.commit()
    finally:
        db.close()
    ent = state(org_id)
    assert ent.state == "FREE_ACTIVE" and ent.last_expired_at is not None
    # Not locked: the browser keeps working on the free plan
    assert client.get("/api/v1/policies", headers=device).status_code == 200
    # The trial cannot be claimed twice
    status = client.get("/api/v1/billing/status", headers=user).json()
    assert status["trial"]["eligible"] is False
    db = SessionLocal()
    try:
        run_reminders(db)
        note = db.query(Notification).filter(Notification.organization_id == org_id, Notification.kind == "expired").first()
        assert note is not None and "Free plan" in note.title and "locked" not in note.body
    finally:
        db.close()


def test_revoked_account_does_not_fall_back_to_free(client):
    org_id, _ = create_company(account_type="INDIVIDUAL", trial=True)
    db = SessionLocal()
    try:
        db.query(License).filter(License.organization_id == org_id).update({"status": "REVOKED"})
        db.commit()
    finally:
        db.close()
    assert state(org_id).state == "REVOKED"


def test_free_plan_cannot_be_granted_or_sold(client):
    from helpers import staff_headers

    org_id, _ = create_company(account_type="INDIVIDUAL")
    staff = staff_headers()
    res = client.post(f"/internal/api/companies/{org_id}/licenses", headers=staff, json={"plan_code": "free", "reason": "test"})
    assert res.status_code == 400
    res = client.patch("/internal/api/plans/free", headers=staff, json={"purchasable": True})
    assert res.status_code == 400
    # Staff can edit the free allowance
    res = client.patch("/internal/api/plans/free", headers=staff, json={"check_limit": 500, "device_limit": 2})
    assert res.status_code == 200 and res.json()["check_limit"] == 500
    assert state(org_id).check_limit == 500
    set_free()


# --- Referrals ---------------------------------------------------------------------------------

@pytest.fixture
def mailbox(monkeypatch):
    sent = []
    monkeypatch.setattr("app.api.auth.send_email", lambda to, subject, body: sent.append((to, body)) or "log")
    return sent


def _signup(client, email, code=None):
    body = {"email": email, "password": "Referral-Pass-2026!", "account_type": "INDIVIDUAL"}
    if code is not None:
        body["referral_code"] = code
    res = client.post("/auth/signup", json=body)
    assert res.status_code == 201, res.text
    return res


def _confirm(client, mailbox, email):
    body = [b for to, b in mailbox if to == email][-1]
    token = re.search(r"#verify=(\S+)", body).group(1)
    res = client.post("/auth/verify-email", json={"token": token})
    assert res.status_code == 200, res.text


def _credits(org_id):
    db = SessionLocal()
    try:
        org = db.query(Organization).filter(Organization.id == org_id).first()
        return org.credit_balance
    finally:
        db.close()


def _org_of(email):
    db = SessionLocal()
    try:
        return db.query(User).filter(User.email == email).first().organization_id
    finally:
        db.close()


def test_referral_rewards_both_after_confirmation(client, mailbox):
    org_id, email = create_company(account_type="INDIVIDUAL")
    info = client.get("/api/v1/referrals", headers=login(client, email)).json()
    assert info["enabled"] is True and info["invited"] == 0 and info["link"].endswith(f"#ref={info['code']}")
    friend = f"friend-{uuid.uuid4().hex[:8]}@friends.example"
    _signup(client, friend, info["code"])
    friend_org = _org_of(friend)
    # Nothing until the friend confirms their email
    assert _credits(org_id) == 0 and _credits(friend_org) == 0
    assert client.get("/api/v1/referrals", headers=login(client, email)).json()["pending"] == 1
    _confirm(client, mailbox, friend)
    bonus = settings.REFERRAL_BONUS_CHECKS
    assert _credits(org_id) == bonus and _credits(friend_org) == bonus
    info = client.get("/api/v1/referrals", headers=login(client, email)).json()
    assert info["rewarded"] == 1 and info["pending"] == 0 and info["bonus_earned"] == bonus
    db = SessionLocal()
    try:
        kinds = {r.kind for r in db.query(CreditLedger).filter(CreditLedger.organization_id.in_((org_id, friend_org)))}
        assert "referral" in kinds
        assert db.query(Notification).filter(Notification.organization_id == org_id, Notification.kind.like("referral_%")).count() == 1
    finally:
        db.close()
    # Confirming again (a second link) does not reward twice
    client.post("/auth/resend-verification", json={"email": friend})
    assert _credits(org_id) == bonus


def test_referral_rewards_are_capped(client, mailbox, monkeypatch):
    monkeypatch.setattr(settings, "REFERRAL_MAX", 1)
    org_id, email = create_company(account_type="INDIVIDUAL")
    code = client.get("/api/v1/referrals", headers=login(client, email)).json()["code"]
    friends = [f"cap-{uuid.uuid4().hex[:8]}@friends.example" for _ in range(2)]
    for f in friends:
        _signup(client, f, code)
        _confirm(client, mailbox, f)
    assert _credits(org_id) == settings.REFERRAL_BONUS_CHECKS
    assert _credits(_org_of(friends[1])) == 0
    db = SessionLocal()
    try:
        statuses = sorted(r.status for r in db.query(Referral).filter(Referral.referrer_org_id == org_id))
        assert statuses == ["NOT_REWARDED", "REWARDED"]
    finally:
        db.close()


def test_no_self_referral_and_unknown_codes_are_ignored(client, mailbox):
    me = f"pat-{uuid.uuid4().hex[:8]}@self.example"
    org_id, email = create_company(account_type="INDIVIDUAL", email=me)
    code = client.get("/api/v1/referrals", headers=login(client, email)).json()["code"]
    alias = me.replace("@", "+second@")
    _signup(client, alias, code)
    _confirm(client, mailbox, alias)
    other = f"x-{uuid.uuid4().hex[:8]}@friends.example"
    _signup(client, other, "not-a-real-code")
    db = SessionLocal()
    try:
        assert db.query(Referral).filter(Referral.referrer_org_id == org_id).count() == 0
        assert db.query(Referral).filter(Referral.referred_org_id == _org_of(other)).count() == 0
    finally:
        db.close()
    assert _credits(org_id) == 0


def test_referrals_are_own_account_only(client):
    _, company_admin = create_company()
    assert client.get("/api/v1/referrals", headers=login(client, company_admin)).json() == {"enabled": False}
    assert client.get("/api/v1/referrals").status_code == 401
