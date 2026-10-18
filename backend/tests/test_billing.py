"""Acceptance tests for SaaS phase 2: Razorpay checkout, confirmation, webhooks, renewals, refunds,
disputes, subscriptions, reconciliation and receipts.

Razorpay is replaced by an in-memory fake (`app.core.razorpay.api_request`), and webhooks are
signed here with a test secret, so no network call or real payment is ever made.
"""
import hashlib
import hmac
import json
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.core import ratelimit
from app.core.config import settings
from app.core.entitlements import aware, current_entitlement, utcnow
from app.db.models import AdminAuditLog, BillingOrder, BillingSubscription, License, Plan
from app.db.seed import init_db
from app.db.session import Base, SessionLocal, engine
from app.main import app
from helpers import create_account, create_company, login, staff_headers

KEY_SECRET = "test_key_secret_for_unit_tests"
WEBHOOK_SECRET = "test_webhook_secret_for_unit_tests"
PRICES = {"six_month": 600_00, "monthly": 120_00}


class FakeRazorpay:
    """Just enough of the Razorpay REST API for the flows under test."""

    def __init__(self):
        self.orders, self.payments, self.subscriptions, self.plans, self.calls = {}, {}, {}, {}, []

    @staticmethod
    def _id(prefix):
        return f"{prefix}_{uuid.uuid4().hex[:14]}"

    def pay(self, order_id=None, amount=None, status="captured", currency="INR", subscription_id=None):
        """A customer paying in Razorpay Checkout."""
        pid = self._id("pay")
        if amount is None:
            amount = self.orders[order_id]["amount"] if order_id else None
        self.payments[pid] = {"id": pid, "entity": "payment", "amount": amount, "currency": currency, "status": status,
                              "order_id": order_id, "method": "upi", "amount_refunded": 0}
        return self.payments[pid]

    def __call__(self, method, path, json=None):
        self.calls.append((method, path, json))
        parts = path.strip("/").split("/")
        if method == "POST" and parts == ["orders"]:
            oid = self._id("order")
            self.orders[oid] = {"id": oid, "amount": json["amount"], "currency": json["currency"], "status": "created"}
            return self.orders[oid]
        if method == "GET" and parts[0] == "orders" and parts[-1] == "payments":
            return {"items": [p for p in self.payments.values() if p["order_id"] == parts[1]]}
        if method == "GET" and parts[0] == "payments":
            return dict(self.payments[parts[1]])
        if method == "POST" and parts[0] == "payments" and parts[-1] == "capture":
            p = self.payments[parts[1]]
            assert json["amount"] == p["amount"]
            p["status"] = "captured"
            return dict(p)
        if method == "POST" and parts[0] == "payments" and parts[-1] == "refund":
            p = self.payments[parts[1]]
            p["amount_refunded"] += json.get("amount", p["amount"] - p["amount_refunded"])
            return {"id": self._id("rfnd"), "payment_id": p["id"], "amount": json.get("amount"), "status": "processed"}
        if method == "POST" and parts == ["plans"]:
            pid = self._id("plan")
            self.plans[pid] = json
            return {"id": pid, **json}
        if method == "POST" and parts == ["subscriptions"]:
            sid = self._id("sub")
            self.subscriptions[sid] = {"id": sid, "status": "created", "plan_id": json["plan_id"]}
            return self.subscriptions[sid]
        if method == "POST" and parts[0] == "subscriptions" and parts[-1] == "cancel":
            self.subscriptions[parts[1]]["status"] = "cancelled"
            return self.subscriptions[parts[1]]
        raise AssertionError(f"unexpected Razorpay call {method} {path}")


@pytest.fixture(scope="module")
def client():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    init_db(db)
    saved = {}
    for code, price in PRICES.items():
        plan = db.query(Plan).filter(Plan.code == code).first()
        saved[code] = (plan.price_minor, plan.purchasable)
        plan.price_minor, plan.purchasable = price, True
    db.commit()
    db.close()
    with TestClient(app) as c:
        yield c
    db = SessionLocal()
    for code, (price, purchasable) in saved.items():
        plan = db.query(Plan).filter(Plan.code == code).first()
        plan.price_minor, plan.purchasable = price, purchasable
        plan.razorpay_plan_id = plan.razorpay_plan_amount = None
    db.commit()
    db.close()


@pytest.fixture
def rp(monkeypatch):
    ratelimit.reset()
    fake = FakeRazorpay()
    monkeypatch.setattr(settings, "RAZORPAY_KEY_ID", "rzp_test_unit")
    monkeypatch.setattr(settings, "RAZORPAY_KEY_SECRET", KEY_SECRET)
    monkeypatch.setattr(settings, "RAZORPAY_WEBHOOK_SECRET", WEBHOOK_SECRET)
    monkeypatch.setattr("app.core.razorpay.api_request", fake)
    return fake


def _sign(secret: str, message: str) -> str:
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def webhook(client, event: str, payload: dict, event_id: str = None, secret: str = WEBHOOK_SECRET):
    raw = json.dumps({"entity": "event", "event": event, "payload": payload, "created_at": 1}).encode()
    return client.post("/api/v1/billing/razorpay/webhook", content=raw, headers={
        "Content-Type": "application/json",
        "X-Razorpay-Signature": hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest(),
        "X-Razorpay-Event-Id": event_id or f"evt_{uuid.uuid4().hex[:14]}",
    })


def company(client, trial=False):
    org_id, email = create_company(trial=trial)
    return org_id, login(client, email)


def paid_licences(org_id):
    db = SessionLocal()
    try:
        return db.query(License).filter(License.organization_id == org_id, License.kind == "PAID").order_by(License.starts_at.asc()).all()
    finally:
        db.close()


def state(org_id):
    db = SessionLocal()
    try:
        return current_entitlement(db, org_id).state
    finally:
        db.close()


def checkout(client, headers, plan="six_month"):
    res = client.post("/api/v1/billing/checkout", json={"plan_code": plan}, headers=headers)
    assert res.status_code == 200, res.text
    return res.json()


def buy(client, rp, headers, plan="six_month"):
    """Checkout + payment + payment.captured webhook. Returns (checkout, payment)."""
    co = checkout(client, headers, plan)
    pay = rp.pay(co["order_id"])
    assert webhook(client, "payment.captured", {"payment": {"entity": pay}}).json()["status"] == "processed"
    return co, pay


# --- Availability and permissions -------------------------------------------------------------

def test_checkout_unavailable_until_razorpay_is_configured(client, monkeypatch):
    monkeypatch.setattr(settings, "RAZORPAY_KEY_ID", "")
    monkeypatch.setattr(settings, "RAZORPAY_KEY_SECRET", "")
    _, headers = company(client)
    assert client.get("/api/v1/billing/config", headers=headers).json()["payments_enabled"] is False
    res = client.post("/api/v1/billing/checkout", json={"plan_code": "six_month"}, headers=headers)
    assert res.status_code == 503


def test_config_exposes_only_the_public_key(client, rp):
    _, headers = company(client)
    body = client.get("/api/v1/billing/config", headers=headers).json()
    assert body == {"payments_enabled": True, "test_mode": True, "key_id": "rzp_test_unit", "seller": settings.BILLING_SELLER_NAME}
    assert KEY_SECRET not in json.dumps(body)


def test_only_company_admins_buy_priced_plans(client, rp):
    org_id, headers = company(client)
    employee = login(client, create_account(org_id=org_id))
    assert client.post("/api/v1/billing/checkout", json={"plan_code": "six_month"}, headers=employee).status_code == 403
    for plan in ("annual", "trial", "internal", "nope"):  # unpriced / not for sale
        assert client.post("/api/v1/billing/checkout", json={"plan_code": plan}, headers=headers).status_code == 400
    assert rp.calls == []


def test_checkout_creates_server_side_order_without_granting(client, rp):
    org_id, headers = company(client)
    co = checkout(client, headers)
    assert co["mode"] == "order" and co["amount"] == PRICES["six_month"] and co["currency"] == "INR"
    assert rp.orders[co["order_id"]]["amount"] == PRICES["six_month"]
    assert paid_licences(org_id) == [] and state(org_id) == "NONE"


# --- Webhooks ---------------------------------------------------------------------------------

def test_captured_payment_activates_the_plan_for_six_months(client, rp):
    org_id, headers = company(client)
    co, pay = buy(client, rp, headers)
    [lic] = paid_licences(org_id)
    assert state(org_id) == "SUBSCRIPTION_ACTIVE" and lic.payment_ref == pay["id"]
    days = (aware(lic.expires_at) - aware(lic.starts_at)).days
    assert 181 <= days <= 184
    orders = client.get("/api/v1/billing/orders", headers=headers).json()
    assert orders[0]["status"] == "paid" and orders[0]["payments"][0]["receipt_number"].startswith("AS-")


def test_invalid_webhook_signature_is_rejected(client, rp):
    org_id, headers = company(client)
    co = checkout(client, headers)
    pay = rp.pay(co["order_id"])
    res = webhook(client, "payment.captured", {"payment": {"entity": pay}}, secret="wrong-secret")
    assert res.status_code == 400
    res = client.post("/api/v1/billing/razorpay/webhook", content=b'{"event":"payment.captured"}', headers={"Content-Type": "application/json"})
    assert res.status_code == 400
    assert paid_licences(org_id) == []


def test_duplicate_events_and_duplicate_payments_grant_one_licence(client, rp):
    org_id, headers = company(client)
    co = checkout(client, headers)
    pay = rp.pay(co["order_id"])
    payload, event_id = {"payment": {"entity": pay}}, f"evt_dup_{uuid.uuid4().hex[:10]}"
    assert webhook(client, "payment.captured", payload, event_id=event_id).json()["status"] == "processed"
    assert webhook(client, "payment.captured", payload, event_id=event_id).json()["status"] == "duplicate"
    webhook(client, "order.paid", payload)  # another event for the same payment
    sig = _sign(KEY_SECRET, f"{co['order_id']}|{pay['id']}")
    res = client.post("/api/v1/billing/checkout/confirm", headers=headers, json={
        "razorpay_order_id": co["order_id"], "razorpay_payment_id": pay["id"], "razorpay_signature": sig})
    assert res.json()["status"] == "paid"
    assert len(paid_licences(org_id)) == 1


def test_amount_mismatch_is_ignored_and_audited(client, rp):
    org_id, headers = company(client)
    co = checkout(client, headers)
    pay = rp.pay(co["order_id"], amount=1_00)
    webhook(client, "payment.captured", {"payment": {"entity": pay}})
    assert paid_licences(org_id) == []
    db = SessionLocal()
    try:
        assert db.query(AdminAuditLog).filter(AdminAuditLog.organization_id == org_id, AdminAuditLog.action == "billing.amount_mismatch").count() == 1
    finally:
        db.close()


def test_authorized_payment_is_captured_by_the_server(client, rp):
    org_id, headers = company(client)
    co = checkout(client, headers)
    pay = rp.pay(co["order_id"], status="authorized")
    webhook(client, "payment.authorized", {"payment": {"entity": pay}})
    assert rp.payments[pay["id"]]["status"] == "captured"
    assert state(org_id) == "SUBSCRIPTION_ACTIVE"


def test_failed_payment_marks_the_order_and_grants_nothing(client, rp):
    org_id, headers = company(client)
    co = checkout(client, headers)
    pay = rp.pay(co["order_id"], status="failed")
    pay["error_description"] = "Card declined by bank"
    webhook(client, "payment.failed", {"payment": {"entity": pay}})
    orders = client.get("/api/v1/billing/orders", headers=headers).json()
    assert orders[0]["status"] == "failed" and orders[0]["failure_reason"] == "Card declined by bank"
    assert paid_licences(org_id) == []
    # Retrying the same order and succeeding still works
    good = rp.pay(co["order_id"])
    webhook(client, "payment.captured", {"payment": {"entity": good}})
    assert state(org_id) == "SUBSCRIPTION_ACTIVE"


# --- Browser confirmation ---------------------------------------------------------------------

def test_forged_checkout_confirmation_is_refused(client, rp):
    org_id, headers = company(client)
    co = checkout(client, headers)
    pay = rp.pay(co["order_id"])
    res = client.post("/api/v1/billing/checkout/confirm", headers=headers, json={
        "razorpay_order_id": co["order_id"], "razorpay_payment_id": pay["id"], "razorpay_signature": "0" * 64})
    assert res.status_code == 400
    assert paid_licences(org_id) == []


def test_signed_confirmation_still_needs_a_captured_payment(client, rp):
    org_id, headers = company(client)
    co = checkout(client, headers)
    pay = rp.pay(co["order_id"], status="created")  # signature fine, money not taken
    sig = _sign(KEY_SECRET, f"{co['order_id']}|{pay['id']}")
    res = client.post("/api/v1/billing/checkout/confirm", headers=headers, json={
        "razorpay_order_id": co["order_id"], "razorpay_payment_id": pay["id"], "razorpay_signature": sig})
    assert res.status_code == 200 and res.json()["status"] == "pending"
    assert paid_licences(org_id) == []


def test_valid_confirmation_activates_immediately(client, rp):
    org_id, headers = company(client)
    co = checkout(client, headers)
    pay = rp.pay(co["order_id"], status="authorized")
    sig = _sign(KEY_SECRET, f"{co['order_id']}|{pay['id']}")
    res = client.post("/api/v1/billing/checkout/confirm", headers=headers, json={
        "razorpay_order_id": co["order_id"], "razorpay_payment_id": pay["id"], "razorpay_signature": sig})
    assert res.json()["status"] == "paid"
    assert state(org_id) == "SUBSCRIPTION_ACTIVE"


def test_cannot_confirm_another_companys_order(client, rp):
    _, headers_a = company(client)
    org_b, headers_b = company(client)
    co = checkout(client, headers_a)
    pay = rp.pay(co["order_id"])
    sig = _sign(KEY_SECRET, f"{co['order_id']}|{pay['id']}")
    res = client.post("/api/v1/billing/checkout/confirm", headers=headers_b, json={
        "razorpay_order_id": co["order_id"], "razorpay_payment_id": pay["id"], "razorpay_signature": sig})
    assert res.status_code == 400
    assert paid_licences(org_b) == []


# --- Renewals ---------------------------------------------------------------------------------

def test_renewals_bought_early_chain_after_the_current_period(client, rp):
    org_id, headers = company(client)
    for _ in range(3):
        buy(client, rp, headers)
    a, b, c = paid_licences(org_id)
    assert aware(b.starts_at) == aware(a.expires_at) and aware(c.starts_at) == aware(b.expires_at)
    status = client.get("/api/v1/billing/status", headers=headers).json()["entitlement"]
    assert status["state"] == "SUBSCRIPTION_ACTIVE"


def test_expired_company_renews_and_resumes(client, rp):
    org_id, headers = company(client, trial=True)
    db = SessionLocal()
    try:
        for l in db.query(License).filter(License.organization_id == org_id).all():
            l.expires_at = utcnow() - timedelta(days=1)
        db.commit()
    finally:
        db.close()
    assert state(org_id) == "EXPIRED"
    buy(client, rp, headers)
    assert state(org_id) == "SUBSCRIPTION_ACTIVE"
    [lic] = paid_licences(org_id)
    assert abs((aware(lic.starts_at) - utcnow()).total_seconds()) < 120  # starts now, not at the old end


# --- Refunds and disputes ---------------------------------------------------------------------

def test_full_refund_revokes_and_partial_refund_keeps(client, rp):
    org_full, h_full = company(client)
    _, pay = buy(client, rp, h_full)
    webhook(client, "refund.processed", {"payment": {"entity": {**pay, "amount_refunded": pay["amount"]}},
                                         "refund": {"entity": {"payment_id": pay["id"], "amount": pay["amount"]}}})
    assert state(org_full) == "REVOKED"
    assert client.get("/api/v1/billing/orders", headers=h_full).json()[0]["status"] == "refunded"

    org_part, h_part = company(client)
    _, pay = buy(client, rp, h_part)
    webhook(client, "refund.processed", {"payment": {"entity": {**pay, "amount_refunded": 100_00}},
                                         "refund": {"entity": {"payment_id": pay["id"], "amount": 100_00}}})
    assert state(org_part) == "SUBSCRIPTION_ACTIVE"
    assert client.get("/api/v1/billing/orders", headers=h_part).json()[0]["payments"][0]["status"] == "partially_refunded"


def test_platform_refund_goes_through_razorpay(client, rp):
    org_id, headers = company(client)
    buy(client, rp, headers)
    platform = staff_headers("BILLING_ADMIN")
    assert client.post("/internal/api/billing/reconcile", headers=headers).status_code == 401
    orders = client.get("/internal/api/billing/orders", headers=platform).json()
    payment = next(o for o in orders if o["organization"] and o["payments"] and paid_licences(org_id)
                   and o["payments"][0]["provider_payment_id"] == paid_licences(org_id)[0].payment_ref)["payments"][0]
    res = client.post(f"/internal/api/billing/payments/{payment['id']}/refund", headers=platform, json={"reason": "Customer request"})
    assert res.status_code == 200 and res.json()["status"] == "processed"
    assert state(org_id) == "REVOKED"
    res = client.post(f"/internal/api/billing/payments/{payment['id']}/refund", headers=platform, json={"reason": "Again"})
    assert res.status_code == 400  # nothing left to refund


def test_dispute_revokes_and_a_won_dispute_restores(client, rp):
    org_id, headers = company(client)
    _, pay = buy(client, rp, headers)
    webhook(client, "payment.dispute.created", {"dispute": {"entity": {"payment_id": pay["id"]}}})
    assert state(org_id) == "REVOKED"
    webhook(client, "payment.dispute.won", {"dispute": {"entity": {"payment_id": pay["id"]}}})
    assert state(org_id) == "SUBSCRIPTION_ACTIVE"


# --- Monthly subscription ---------------------------------------------------------------------

def test_monthly_subscription_charges_cancel_and_reminders(client, rp):
    org_id, headers = company(client)
    co = checkout(client, headers, "monthly")
    assert co["mode"] == "subscription"
    sub_id = co["subscription_id"]
    assert client.post("/api/v1/billing/checkout", json={"plan_code": "monthly"}, headers=headers).status_code == 200  # not active yet
    sub_entity = {"id": sub_id, "status": "active", "current_end": int((utcnow() + timedelta(days=30)).timestamp())}
    webhook(client, "subscription.activated", {"subscription": {"entity": sub_entity}})
    assert client.post("/api/v1/billing/checkout", json={"plan_code": "monthly"}, headers=headers).status_code == 409

    for _ in range(2):  # first charge and one renewal
        pay = rp.pay(amount=PRICES["monthly"])
        webhook(client, "subscription.charged", {"subscription": {"entity": sub_entity}, "payment": {"entity": pay}})
    first, second = paid_licences(org_id)
    assert aware(second.starts_at) == aware(first.expires_at)

    # Browser confirmation for a subscription is signed payment_id|subscription_id
    pay = rp.pay(amount=PRICES["monthly"])
    sig = _sign(KEY_SECRET, f"{pay['id']}|{sub_id}")
    res = client.post("/api/v1/billing/checkout/confirm", headers=headers, json={
        "razorpay_subscription_id": sub_id, "razorpay_payment_id": pay["id"], "razorpay_signature": sig})
    assert res.json()["status"] == "paid" and len(paid_licences(org_id)) == 3

    from app.core.payments import has_auto_renewal
    db = SessionLocal()
    try:
        assert has_auto_renewal(db, org_id)
    finally:
        db.close()
    res = client.post("/api/v1/billing/subscription/cancel", headers=headers)
    assert res.status_code == 200 and res.json()["cancel_at_period_end"] is True
    assert ("POST", f"/subscriptions/{sub_id}/cancel", {"cancel_at_cycle_end": 1}) in rp.calls
    db = SessionLocal()
    try:
        assert not has_auto_renewal(db, org_id)
    finally:
        db.close()
    assert state(org_id) == "SUBSCRIPTION_ACTIVE"  # the paid time stays


def test_recurring_price_change_creates_a_new_razorpay_plan(client, rp):
    _, headers = company(client)
    checkout(client, headers, "monthly")
    db = SessionLocal()
    try:
        plan = db.query(Plan).filter(Plan.code == "monthly").first()
        old_id = plan.razorpay_plan_id
        plan.price_minor = 150_00
        db.commit()
    finally:
        db.close()
    _, headers2 = company(client)
    co = checkout(client, headers2, "monthly")
    db = SessionLocal()
    try:
        plan = db.query(Plan).filter(Plan.code == "monthly").first()
        assert plan.razorpay_plan_id != old_id and plan.razorpay_plan_amount == 150_00 and co["amount"] == 150_00
        plan.price_minor = PRICES["monthly"]
        db.commit()
    finally:
        db.close()


# --- Reconciliation and receipts --------------------------------------------------------------

def test_reconcile_completes_a_payment_whose_webhook_was_missed(client, rp):
    org_id, headers = company(client)
    co = checkout(client, headers)
    rp.pay(co["order_id"])  # paid at Razorpay, webhook never arrived
    assert state(org_id) == "NONE"
    res = client.post("/internal/api/billing/reconcile", headers=staff_headers("BILLING_ADMIN"))
    assert res.status_code == 200 and res.json()["completed"] >= 1
    assert state(org_id) == "SUBSCRIPTION_ACTIVE"
    res = client.post("/internal/api/billing/reconcile", headers=staff_headers("BILLING_ADMIN"))
    assert len(paid_licences(org_id)) == 1  # running again changes nothing


def test_receipt_is_visible_only_to_its_company(client, rp):
    org_id, headers = company(client)
    buy(client, rp, headers)
    payment = client.get("/api/v1/billing/orders", headers=headers).json()[0]["payments"][0]
    res = client.get(f"/api/v1/billing/payments/{payment['id']}/receipt", headers=headers)
    assert res.status_code == 200 and payment["receipt_number"] in res.text and "text/html" in res.headers["content-type"]
    _, other = company(client)
    assert client.get(f"/api/v1/billing/payments/{payment['id']}/receipt", headers=other).status_code == 404
    assert client.get("/api/v1/billing/orders", headers=other).json() == []


def test_webhook_for_unknown_order_is_ignored(client, rp):
    pay = rp.pay(amount=100_00)
    pay["order_id"] = "order_unknown"
    res = webhook(client, "payment.captured", {"payment": {"entity": pay}})
    assert res.status_code == 200 and res.json()["status"] == "ignored"
    db = SessionLocal()
    try:
        assert db.query(BillingOrder).filter(BillingOrder.provider_order_id == "order_unknown").count() == 0
        assert db.query(BillingSubscription).count() >= 0
    finally:
        db.close()
