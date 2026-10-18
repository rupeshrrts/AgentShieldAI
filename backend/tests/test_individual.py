"""Individual launch: account types (Company "coming soon"), usage metering, prepaid credits and
limits, credit-pack payments, personal API tokens, and the internal console's credit controls.

Razorpay is replaced by the in-memory fake from test_billing.py; webhooks are signed here.
"""
import hashlib
import hmac
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.core import ratelimit
from app.core.config import settings
from app.core.entitlements import current_entitlement, utcnow
from app.db.models import CreditLedger, License, Organization, Plan, UsageDaily
from app.db.seed import init_db
from app.db.session import Base, SessionLocal, engine
from app.main import app
from helpers import DeviceKeys, activate, activation_token, create_company, login, session, staff_headers
from test_billing import KEY_SECRET, WEBHOOK_SECRET, FakeRazorpay

PACK_PRICE = 199_00


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    init_db(db)
    pack = db.query(Plan).filter(Plan.code == "credits_1000").first()
    saved = (pack.price_minor, pack.purchasable)
    pack.price_minor, pack.purchasable = PACK_PRICE, True
    db.commit()
    db.close()
    with TestClient(app) as c:
        yield c
    db = SessionLocal()
    pack = db.query(Plan).filter(Plan.code == "credits_1000").first()
    pack.price_minor, pack.purchasable = saved
    db.commit()
    db.close()


@pytest.fixture(autouse=True)
def _limits():
    ratelimit.reset()
    yield


@pytest.fixture
def rp(monkeypatch):
    fake = FakeRazorpay()
    monkeypatch.setattr(settings, "RAZORPAY_KEY_ID", "rzp_test_unit")
    monkeypatch.setattr(settings, "RAZORPAY_KEY_SECRET", KEY_SECRET)
    monkeypatch.setattr(settings, "RAZORPAY_WEBHOOK_SECRET", WEBHOOK_SECRET)
    monkeypatch.setattr("app.core.razorpay.api_request", fake)
    return fake


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def connected(client, trial=False, credits=0):
    """An individual account with an activated browser. Returns (org_id, user headers, device headers)."""
    org_id, email = create_company(trial=trial, credits=credits, account_type="INDIVIDUAL")
    user = login(client, email)
    keys = DeviceKeys()
    res = activate(client, activation_token(client, user), keys)
    assert res.status_code == 201, res.text
    sess = session(client, res.json()["device_id"], keys)
    assert sess.status_code == 200, sess.text
    return org_id, user, _bearer(sess.json()["session_token"])


def prompt_event(**extra) -> dict:
    body = {"site": "chatgpt.com", "rule_id": "general.clean_prompt", "category": "PROMPT_LOG", "severity": "LOW",
            "action": "ALLOW", "outcome": "allowed", "client_event_id": uuid.uuid4().hex}
    body.update(extra)
    return body


def usage(org_id):
    db = SessionLocal()
    try:
        rows = db.query(UsageDaily).filter(UsageDaily.organization_id == org_id).all()
        org = db.query(Organization).filter(Organization.id == org_id).first()
        return sum(r.prompt_checks for r in rows), sum(r.credit_checks for r in rows), org.credit_balance
    finally:
        db.close()


def set_plan_limit(code, limit):
    db = SessionLocal()
    try:
        db.query(Plan).filter(Plan.code == code).update({"check_limit": limit})
        db.commit()
    finally:
        db.close()


# --- Account types -----------------------------------------------------------------------------

def test_company_signup_is_coming_soon(client, monkeypatch):
    monkeypatch.setattr("app.api.auth.send_email", lambda *a: "log")
    info = client.get("/auth/signup-info").json()
    assert info["individual_enabled"] is True and info["company_enabled"] is False
    res = client.post("/auth/signup", json={"email": f"co-{uuid.uuid4().hex[:6]}@acme-x.example", "password": "Company-Pass-2026!",
                                            "account_type": "COMPANY", "company_name": "Acme X"})
    assert res.status_code == 403 and res.json()["detail"]["code"] == "COMPANY_COMING_SOON"


def test_individual_accounts_cannot_use_company_management(client):
    org_id, email = create_company(account_type="INDIVIDUAL")
    headers = login(client, email)
    for method, path, body in (("get", "/api/v1/org/users", None), ("post", "/api/v1/org/users/invite", {"email": "a@b.example", "role": "EMPLOYEE"}),
                               ("get", "/api/v1/org/devices", None)):
        res = getattr(client, method)(path, headers=headers, **({"json": body} if body else {}))
        assert res.status_code == 403 and res.json()["detail"]["code"] == "COMPANY_FEATURE_UNAVAILABLE", path
    # Their own browsers stay manageable
    assert client.get("/api/v1/me/devices", headers=headers).status_code == 200
    # Existing company workspaces keep the company features
    _, company_admin = create_company()
    assert client.get("/api/v1/org/users", headers=login(client, company_admin)).status_code == 200


def test_profile_name_updates_individual_account(client):
    org_id, email = create_company(account_type="INDIVIDUAL")
    res = client.patch("/auth/me", headers=login(client, email), json={"display_name": "Ravi Kumar"})
    assert res.status_code == 200 and res.json()["display_name"] == "Ravi Kumar" and res.json()["organization_name"] == "Ravi Kumar"


# --- Metering ----------------------------------------------------------------------------------

def test_prompt_checks_are_metered_once(client):
    org_id, user, device = connected(client, trial=True)
    body = prompt_event()
    assert client.post("/api/v1/events", headers=device, json=body).status_code == 201
    assert client.post("/api/v1/events", headers=device, json=body).status_code == 201  # retry / offline replay
    client.post("/api/v1/events", headers=device, json=prompt_event(rule_id="secret.aws_key", category="SECRET",
                                                                    severity="CRITICAL", action="BLOCK", outcome="blocked"))
    # Website blocks and file uploads are not prompt checks
    client.post("/api/v1/events", headers=device, json=prompt_event(rule_id="dlp.domain_block", category="DOMAIN",
                                                                    action="BLOCK", outcome="navigation_blocked"))
    client.post("/api/v1/events", headers=device, json=prompt_event(action="MONITOR", outcome="file_monitored"))
    checks, credit_checks, _ = usage(org_id)
    assert checks == 2 and credit_checks == 0
    res = client.get("/api/v1/usage?days=7", headers=user).json()
    assert res["totals"]["prompt_checks"] == 2 and res["totals"]["blocked"] == 1 and len(res["daily"]) == 7
    assert res["entitlement"]["checks_this_month"] == 2


def test_dashboard_tokens_are_not_metered(client):
    org_id, email = create_company(trial=True, account_type="INDIVIDUAL")
    client.post("/api/v1/events", headers=login(client, email), json=prompt_event())
    assert usage(org_id)[0] == 0


def test_plan_limit_then_credits_then_lock(client):
    set_plan_limit("trial", 2)
    try:
        org_id, user, device = connected(client, trial=True, credits=1)
        for _ in range(2):
            assert client.post("/api/v1/events", headers=device, json=prompt_event()).status_code == 201
        # Included checks used up: the next one is paid with the single credit
        assert client.post("/api/v1/events", headers=device, json=prompt_event()).status_code == 201
        checks, credit_checks, balance = usage(org_id)
        assert (checks, credit_checks, balance) == (3, 1, 0)
        # Nothing left: the browser is locked on its next request
        res = client.get("/api/v1/policies", headers=device)
        assert res.status_code == 403 and res.json()["detail"]["code"] == "USAGE_LIMIT"
        assert client.post("/api/v1/me/activation-tokens", headers=user).status_code == 403
    finally:
        set_plan_limit("trial", None)


def test_credits_only_account_runs_until_credits_end(client, monkeypatch):
    # Pay as you go without the free plan (e.g. FREE_TIER_ENABLED=false; unconfirmed individuals work the same way)
    monkeypatch.setattr(settings, "FREE_TIER_ENABLED", False)
    org_id, user, device = connected(client, credits=2)
    db = SessionLocal()
    try:
        assert current_entitlement(db, org_id).state == "CREDITS_ACTIVE"
    finally:
        db.close()
    for _ in range(2):
        assert client.post("/api/v1/events", headers=device, json=prompt_event()).status_code == 201
    assert usage(org_id) == (2, 2, 0)
    res = client.get("/api/v1/policies", headers=device)
    assert res.status_code == 403 and res.json()["detail"]["code"] == "NO_CREDITS"
    notes = client.get("/api/v1/billing/status", headers=user).json()["notifications"]
    assert any(n["kind"].startswith("credits_out_") for n in notes)


def test_credits_cannot_be_spent_twice(client):
    from app.core.usage import take_credit

    org_id, _ = create_company(account_type="INDIVIDUAL", credits=1)
    db = SessionLocal()
    try:
        assert take_credit(db, org_id) == 0
        assert take_credit(db, org_id) is None  # never below zero
        db.commit()
    finally:
        db.close()


def test_monthly_cap_locks_and_can_be_raised(client):
    org_id, user, device = connected(client, trial=True)
    assert client.patch("/api/v1/usage/settings", headers=user, json={"monthly_check_cap": 1}).status_code == 200
    assert client.post("/api/v1/events", headers=device, json=prompt_event()).status_code == 201
    res = client.get("/api/v1/policies", headers=device)
    assert res.status_code == 403 and res.json()["detail"]["code"] == "SPEND_CAP"
    assert client.patch("/api/v1/usage/settings", headers=user, json={"monthly_check_cap": None}).status_code == 200
    assert client.get("/api/v1/policies", headers=device).status_code == 200


def test_client_cannot_set_its_own_balance_or_usage(client):
    org_id, user, device = connected(client, trial=True)
    # Unknown fields are ignored; usage and credits are only changed by the server
    client.post("/api/v1/events", headers=device, json={**prompt_event(), "credit_balance": 999999, "organization_id": "other"})
    assert client.patch("/api/v1/usage/settings", headers=user, json={"credit_balance": 5000}).status_code == 200
    assert usage(org_id)[2] == 0


# --- Credit packs (verified payments only) ----------------------------------------------------

def _signed_webhook(client, event, payload):
    raw = json.dumps({"event": event, "payload": payload}).encode()
    return client.post("/api/v1/billing/razorpay/webhook", content=raw, headers={
        "Content-Type": "application/json", "X-Razorpay-Event-Id": f"evt_{uuid.uuid4().hex[:12]}",
        "X-Razorpay-Signature": hmac.new(WEBHOOK_SECRET.encode(), raw, hashlib.sha256).hexdigest()})


def test_credit_pack_purchase_refund_and_dispute(client, rp):
    org_id, email = create_company(account_type="INDIVIDUAL")
    headers = login(client, email)
    co = client.post("/api/v1/billing/checkout", headers=headers, json={"plan_code": "credits_1000"})
    assert co.status_code == 200 and co.json()["amount"] == PACK_PRICE
    # Nothing is added before a verified payment
    assert usage(org_id)[2] == 0
    pay = rp.pay(co.json()["order_id"])
    assert _signed_webhook(client, "payment.captured", {"payment": {"entity": pay}}).json()["status"] == "processed"
    assert usage(org_id)[2] == 1000
    # Same payment again (duplicate webhook): no double credit
    _signed_webhook(client, "order.paid", {"payment": {"entity": pay}})
    assert usage(org_id)[2] == 1000
    db = SessionLocal()
    try:
        # A confirmed individual uses the free plan first, then these credits (test_free.py)
        ent = current_entitlement(db, org_id)
        assert ent.state == "FREE_ACTIVE" and ent.credit_balance == 1000
        assert db.query(License).filter(License.organization_id == org_id).count() == 0
    finally:
        db.close()
    # Dispute takes the credits back, a won dispute restores them, a full refund removes them
    _signed_webhook(client, "payment.dispute.created", {"dispute": {"entity": {"payment_id": pay["id"]}}})
    assert usage(org_id)[2] == 0
    _signed_webhook(client, "payment.dispute.won", {"dispute": {"entity": {"payment_id": pay["id"]}}})
    assert usage(org_id)[2] == 1000
    _signed_webhook(client, "refund.processed", {"payment": {"entity": {**pay, "amount_refunded": pay["amount"]}}})
    assert usage(org_id)[2] == 0
    ledger = client.get("/api/v1/usage/credits", headers=headers).json()
    assert [e["kind"] for e in ledger["entries"]][::-1] == ["purchase", "dispute", "dispute_won", "refund"]


def test_credit_pack_mismatched_amount_adds_nothing(client, rp):
    org_id, email = create_company(account_type="INDIVIDUAL")
    co = client.post("/api/v1/billing/checkout", headers=login(client, email), json={"plan_code": "credits_1000"}).json()
    pay = rp.pay(co["order_id"], amount=1_00)
    _signed_webhook(client, "payment.captured", {"payment": {"entity": pay}})
    assert usage(org_id)[2] == 0


# --- Internal console credit controls ---------------------------------------------------------

def test_staff_credit_grants_are_owner_exceptions(client):
    org_id, _ = create_company(account_type="INDIVIDUAL")
    admin = staff_headers("PLATFORM_ADMIN")
    assert client.post(f"/internal/api/companies/{org_id}/credits", headers=admin, json={"delta": 500, "reason": "goodwill"}).status_code == 403
    owner = staff_headers("PLATFORM_OWNER")
    res = client.post(f"/internal/api/companies/{org_id}/credits", headers=owner, json={"delta": 500, "reason": "launch promo"})
    assert res.status_code == 200 and res.json()["credit_balance"] == 500
    # Removing credits (e.g. abuse) is allowed for administrators, never below zero
    res = client.post(f"/internal/api/companies/{org_id}/credits", headers=admin, json={"delta": -900, "reason": "abuse"})
    assert res.status_code == 200 and res.json()["credit_balance"] == 0
    detail = client.get(f"/internal/api/companies/{org_id}/usage", headers=staff_headers("SUPPORT_AGENT")).json()
    assert [l["kind"] for l in detail["ledger"]] == ["adjust", "grant"]
    db = SessionLocal()
    try:
        assert db.query(CreditLedger).filter(CreditLedger.organization_id == org_id, CreditLedger.kind == "grant").first().created_by.startswith("staff:")
    finally:
        db.close()
    # A credit pack cannot be "granted" as a licence
    assert client.post(f"/internal/api/companies/{org_id}/licenses", headers=owner,
                       json={"plan_code": "credits_1000", "reason": "test"}).status_code == 400


def test_platform_metrics_and_health(client):
    owner = staff_headers("PLATFORM_OWNER")
    m = client.get("/internal/api/metrics", headers=owner).json()
    assert {"accounts_by_type", "prompt_checks_this_month", "credits_outstanding", "net_revenue_this_month"} <= set(m)
    h = client.get("/internal/api/health", headers=owner).json()
    assert h["database"]["ok"] is True and "activation_failures" in h["last_24h"]
    assert client.get("/internal/api/health", headers=staff_headers("SUPPORT_AGENT")).status_code == 403


def test_platform_analytics(client):
    org_id, _user, device = connected(client, trial=True)
    client.post("/api/v1/events", headers=device, json=prompt_event(rule_id="secret.aws_key", category="SECRET", severity="CRITICAL",
                                                                    action="BLOCK", outcome="blocked", prompt="my key AKIAABCDEFGHIJKLMNOP"))
    owner = staff_headers("PLATFORM_OWNER")
    res = client.get("/internal/api/analytics?days=14", headers=owner)
    assert res.status_code == 200
    a = res.json()
    assert len(a["signups_daily"]) == 14 and len(a["checks_daily"]) == 14
    assert a["signups_daily"][-1]["day"] == datetime.now(timezone.utc).strftime("%Y-%m-%d")
    assert sum(d["individual"] + d["company"] for d in a["signups_daily"]) >= 1
    assert a["checks_daily"][-1]["prompt_checks"] >= 1 and a["checks_daily"][-1]["blocked"] >= 1
    assert a["actions"].get("BLOCK", 0) >= 1 and a["categories"].get("SECRET", 0) >= 1
    assert sum(a["browsers"].values()) >= 1
    assert any(t["prompt_checks"] >= 1 for t in a["top_accounts_this_month"])
    # Counts only: no prompt text or customer email addresses
    assert "AKIA" not in res.text and "@" not in res.text
    assert client.get("/internal/api/analytics", headers=staff_headers("SUPPORT_AGENT")).status_code == 403
    assert client.get("/internal/api/analytics?days=3", headers=owner).status_code == 422


# --- Personal API tokens ----------------------------------------------------------------------

def test_personal_api_tokens(client):
    org_id, user, device = connected(client, trial=True)
    client.post("/api/v1/events", headers=device, json=prompt_event(rule_id="secret.aws_key", category="SECRET", severity="CRITICAL",
                                                                    action="BLOCK", outcome="blocked", prompt="my key AKIAABCDEFGHIJKLMNOP"))
    res = client.post("/api/v1/me/api-tokens", headers=user, json={"name": "SIEM", "scopes": ["alerts:read"], "expires_in_days": 30})
    assert res.status_code == 201 and res.json()["token"].startswith("aspt_")
    raw = res.json()["token"]
    listed = client.get("/api/v1/me/api-tokens", headers=user).json()["tokens"]
    assert all("token" not in t for t in listed) and listed[0]["prefix"] == raw[:12]

    alerts = client.get("/api/v1/public/alerts", headers=_bearer(raw))
    assert alerts.status_code == 200 and alerts.json()["alerts"][0]["action"] == "BLOCK"
    assert "AKIA" not in alerts.text  # prompt text is never returned
    assert client.get("/api/v1/public/usage", headers=_bearer(raw)).status_code == 403  # scope not granted
    # The token works nowhere else
    for path in ("/api/v1/policies", "/auth/me", "/api/v1/usage", "/internal/api/companies"):
        assert client.get(path, headers=_bearer(raw)).status_code == 401, path
    # Another account's token cannot read this account
    _, other_user, _ = connected(client, trial=True)
    other = client.post("/api/v1/me/api-tokens", headers=other_user, json={"name": "Other", "scopes": ["alerts:read", "usage:read"]}).json()
    assert client.get("/api/v1/public/alerts", headers=_bearer(other["token"])).json()["alerts"] == []
    assert client.get("/api/v1/public/usage", headers=_bearer(other["token"])).status_code == 200
    # Revoked tokens stop working at once
    client.delete(f"/api/v1/me/api-tokens/{res.json()['id']}", headers=user)
    assert client.get("/api/v1/public/alerts", headers=_bearer(raw)).status_code == 401
    assert client.post("/api/v1/me/api-tokens", headers=user, json={"name": "bad", "scopes": ["admin:write"]}).status_code == 400
