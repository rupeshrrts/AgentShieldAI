"""Razorpay checkout, payment confirmation, webhooks, billing history, receipts and subscriptions.

Customer (company admin):
  GET  /api/v1/billing/config                 whether online payment is available (+ public key id, test mode)
  POST /api/v1/billing/checkout               server creates the Razorpay order / subscription
  POST /api/v1/billing/checkout/confirm       checkout result: signature checked AND payment fetched from Razorpay
  GET  /api/v1/billing/orders                 billing history (own company)
  GET  /api/v1/billing/payments/{id}/receipt  printable receipt (own company)
  GET  /api/v1/billing/subscription           current recurring subscription
  POST /api/v1/billing/subscription/cancel    cancel at the end of the paid period
Razorpay:
  POST /api/v1/billing/razorpay/webhook       HMAC-verified, idempotent per event id
Internal console (staff; billing.read / billing.refund / billing.reconcile):
  GET  /internal/api/billing/orders, /webhooks; POST .../payments/{id}/refund, .../reconcile

Licences are granted only in core/payments.py:fulfil_payment, from a captured payment.
"""
import hashlib
import html
import json
import logging
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin, get_signed_in_user
from app.core.permissions import require_staff
from app.core import razorpay, ratelimit
from app.core.audit import record_admin_action
from app.core.config import settings
from app.core.entitlements import aware, utcnow
from app.core.payments import apply_dispute, apply_refund, fulfil_payment, mark_failed, to_dt
from app.db.models import BillingOrder, BillingPayment, BillingSubscription, Organization, Plan, StaffUser, User, WebhookEvent
from app.db.session import get_db

logger = logging.getLogger("agentshield.payments")

router = APIRouter(prefix="/api/v1/billing", tags=["Payments"])
platform_router = APIRouter(prefix="/internal/api/billing", tags=["Internal console"])

SUBSCRIPTION_CYCLES = 120  # monthly renewals authorised up front (10 years); cancellable any time


def _iso(dt) -> Optional[str]:
    return aware(dt).isoformat() if dt else None


def _rp_error(exc: razorpay.RazorpayError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


# --- Customer ----------------------------------------------------------------------------------

@router.get("/config")
def billing_config(user: User = Depends(get_signed_in_user)):
    return {
        "payments_enabled": settings.payments_configured,
        "test_mode": settings.payments_test_mode,
        "key_id": settings.RAZORPAY_KEY_ID if settings.payments_configured else None,
        "seller": settings.BILLING_SELLER_NAME,
    }


class CheckoutRequest(BaseModel):
    plan_code: str = Field(..., max_length=30)


def _ensure_razorpay_plan(db: Session, plan: Plan) -> str:
    """Recurring billing needs a Razorpay plan with the current price; created (again) when the price changes."""
    if plan.razorpay_plan_id and plan.razorpay_plan_amount == plan.price_minor:
        return plan.razorpay_plan_id
    months = plan.duration_months or 1
    created = razorpay.create_plan(f"AgentShield {plan.name}", plan.price_minor, plan.currency, "monthly", months)
    plan.razorpay_plan_id, plan.razorpay_plan_amount = created["id"], plan.price_minor
    db.commit()
    return plan.razorpay_plan_id


@router.post("/checkout")
def checkout(body: CheckoutRequest, request: Request, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Creates the payment at Razorpay. Nothing is granted here; see /checkout/confirm and the webhook."""
    ratelimit.hit("checkout", admin.id, 20, 60 * 60, "Too many checkout attempts. Try again later.")
    if not settings.payments_configured:
        raise HTTPException(status_code=503, detail="Online payment is not available yet. Contact AgentShield to activate a plan.")
    plan = db.query(Plan).filter(Plan.code == body.plan_code, Plan.active == True).first()
    if not plan or plan.kind not in ("PAID", "CREDITS") or not plan.purchasable or not plan.price_minor:
        raise HTTPException(status_code=400, detail="This plan is not available for purchase.")
    if plan.kind == "CREDITS" and (not plan.credits or plan.billing == "recurring"):
        raise HTTPException(status_code=400, detail="This credit pack is not available for purchase.")
    org = db.query(Organization).filter(Organization.id == admin.organization_id).first()
    if org is None or org.suspended_at is not None:
        raise HTTPException(status_code=403, detail="This company is suspended. Contact support.")

    notes = {"organization_id": admin.organization_id, "plan_code": plan.code, "user": admin.email}
    common = {
        "key_id": settings.RAZORPAY_KEY_ID, "name": settings.BILLING_SELLER_NAME, "description": f"AgentShield {plan.name}",
        "amount": plan.price_minor, "currency": plan.currency, "prefill": {"email": admin.email}, "test_mode": settings.payments_test_mode,
    }
    try:
        if plan.billing == "recurring":
            live = db.query(BillingSubscription).filter(
                BillingSubscription.organization_id == admin.organization_id,
                BillingSubscription.status.in_(("active", "authenticated")),
                BillingSubscription.cancel_at_period_end == False,
            ).first()
            if live:
                raise HTTPException(status_code=409, detail="Your company already has an active monthly subscription.")
            plan_id = _ensure_razorpay_plan(db, plan)
            sub = razorpay.create_subscription(plan_id, SUBSCRIPTION_CYCLES, notes)
            db.add(BillingSubscription(organization_id=admin.organization_id, plan_code=plan.code, provider_subscription_id=sub["id"], status=sub.get("status", "created")))
            order = BillingOrder(organization_id=admin.organization_id, user_id=admin.id, plan_code=plan.code, kind="subscription",
                                 amount_minor=plan.price_minor, currency=plan.currency, provider_subscription_id=sub["id"])
            db.add(order)
            db.commit()
            result = {**common, "mode": "subscription", "subscription_id": sub["id"], "order": order.id}
        else:
            order = BillingOrder(organization_id=admin.organization_id, user_id=admin.id, plan_code=plan.code, kind="one_time",
                                 amount_minor=plan.price_minor, currency=plan.currency)
            db.add(order)
            db.flush()
            rp = razorpay.create_order(plan.price_minor, plan.currency, order.id[:40], {**notes, "order": order.id})
            order.provider_order_id = rp["id"]
            db.commit()
            result = {**common, "mode": "order", "order_id": rp["id"], "order": order.id}
    except razorpay.RazorpayError as exc:
        db.rollback()
        raise _rp_error(exc)
    record_admin_action(db, organization_id=admin.organization_id, actor=admin.email, action="billing.checkout",
                        target_type="order", target_id=result["order"], summary=f"Started checkout for {plan.name}", request=request)
    return result


class ConfirmRequest(BaseModel):
    razorpay_payment_id: str = Field(..., max_length=60)
    razorpay_signature: str = Field(..., max_length=200)
    razorpay_order_id: Optional[str] = Field(default=None, max_length=60)
    razorpay_subscription_id: Optional[str] = Field(default=None, max_length=60)


@router.post("/checkout/confirm")
def confirm(body: ConfirmRequest, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Finishes a checkout the browser reports as successful — only after verifying it with Razorpay.

    1. The checkout signature must match (proves the ids came from Razorpay for this key).
    2. The payment is fetched from Razorpay's API and must be captured, for this order and amount.
    Otherwise nothing is granted (the webhook may still complete it later).
    """
    if body.razorpay_order_id:
        order = db.query(BillingOrder).filter(BillingOrder.provider_order_id == body.razorpay_order_id,
                                              BillingOrder.organization_id == admin.organization_id).first()
        valid = order is not None and razorpay.verify_checkout_order(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature)
        subscription = None
    elif body.razorpay_subscription_id:
        subscription = db.query(BillingSubscription).filter(BillingSubscription.provider_subscription_id == body.razorpay_subscription_id,
                                                            BillingSubscription.organization_id == admin.organization_id).first()
        order = None
        valid = subscription is not None and razorpay.verify_checkout_subscription(body.razorpay_subscription_id, body.razorpay_payment_id, body.razorpay_signature)
    else:
        raise HTTPException(status_code=400, detail="Missing order or subscription id.")
    if not valid:
        record_admin_action(db, organization_id=admin.organization_id, actor=admin.email, action="billing.confirm_refused",
                            target_type="payment", target_id=body.razorpay_payment_id, summary="Checkout confirmation with an invalid signature")
        raise HTTPException(status_code=400, detail="The payment could not be verified.")
    try:
        payment = razorpay.fetch_payment(body.razorpay_payment_id)
        if payment.get("status") == "authorized" and order is not None:
            payment = razorpay.capture_payment(payment["id"], order.amount_minor, order.currency)
    except razorpay.RazorpayError as exc:
        raise _rp_error(exc)
    row = fulfil_payment(db, payment, order=order, subscription=subscription, source="checkout")
    if row is None:
        return {"status": "pending", "message": "Payment received by Razorpay but not confirmed yet. Your plan activates as soon as it is."}
    return {"status": "paid", "receipt_number": row.receipt_number}


def _order_out(o: BillingOrder, payments) -> dict:
    return {
        "id": o.id, "plan_code": o.plan_code, "kind": o.kind, "amount_minor": o.amount_minor, "currency": o.currency,
        "status": o.status, "failure_reason": o.failure_reason, "created_at": _iso(o.created_at), "paid_at": _iso(o.paid_at),
        "payments": [
            {"id": p.id, "provider_payment_id": p.provider_payment_id, "amount_minor": p.amount_minor, "currency": p.currency,
             "status": p.status, "refunded_minor": p.refunded_minor, "receipt_number": p.receipt_number, "created_at": _iso(p.created_at)}
            for p in payments
        ],
    }


@router.get("/orders")
def my_orders(user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)):
    orders = db.query(BillingOrder).filter(BillingOrder.organization_id == user.organization_id).order_by(BillingOrder.created_at.desc()).limit(100).all()
    return [
        _order_out(o, db.query(BillingPayment).filter(BillingPayment.order_id == o.id).order_by(BillingPayment.created_at.asc()).all())
        for o in orders if o.status != "created" or (utcnow() - aware(o.created_at)) < timedelta(hours=1)
    ]


@router.get("/payments/{payment_id}/receipt", response_class=HTMLResponse)
def receipt(payment_id: str, user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)):
    p = db.query(BillingPayment).filter(BillingPayment.id == payment_id, BillingPayment.organization_id == user.organization_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Receipt not found.")
    order = db.query(BillingOrder).filter(BillingOrder.id == p.order_id).first() if p.order_id else None
    plan = db.query(Plan).filter(Plan.code == (order.plan_code if order else "")).first()
    org = db.query(Organization).filter(Organization.id == p.organization_id).first()
    e = html.escape
    amount = f"{p.amount_minor / 100:,.2f} {p.currency}"
    refunded = f"<tr><td>Refunded</td><td>{p.refunded_minor / 100:,.2f} {p.currency}</td></tr>" if p.refunded_minor else ""
    return HTMLResponse(f"""<!doctype html><html><head><meta charset="utf-8"><title>Receipt {e(p.receipt_number or '')}</title>
<style>body{{font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:40px auto;color:#0f172a}}h1{{font-size:22px}}
table{{width:100%;border-collapse:collapse;margin-top:16px}}td{{padding:8px;border-bottom:1px solid #e2e8f0}}td:first-child{{color:#64748b;width:40%}}
.muted{{color:#64748b;font-size:12px}}</style></head><body>
<h1>Payment receipt</h1><div class="muted">{e(settings.BILLING_SELLER_NAME)} {e(settings.BILLING_SELLER_DETAILS)}</div>
<table>
<tr><td>Receipt number</td><td>{e(p.receipt_number or '')}</td></tr>
<tr><td>Date</td><td>{e(aware(p.created_at).strftime('%d %b %Y %H:%M UTC'))}</td></tr>
<tr><td>Billed to</td><td>{e(org.name if org else '')}</td></tr>
<tr><td>Plan</td><td>AgentShield {e(plan.name if plan else (order.plan_code if order else ''))}</td></tr>
<tr><td>Amount paid</td><td>{e(amount)}</td></tr>{refunded}
<tr><td>Payment reference</td><td>{e(p.provider_payment_id)} ({e(p.method or 'Razorpay')})</td></tr>
<tr><td>Status</td><td>{e('paid' if p.status == 'captured' else p.status.replace('_', ' '))}</td></tr>
</table><p class="muted">This is a payment receipt, not a tax invoice. Processed by Razorpay.</p></body></html>""")


@router.get("/subscription")
def my_subscription(user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)):
    sub = (db.query(BillingSubscription).filter(BillingSubscription.organization_id == user.organization_id)
           .order_by(BillingSubscription.created_at.desc()).first())
    if not sub:
        return None
    return {"plan_code": sub.plan_code, "status": sub.status, "cancel_at_period_end": bool(sub.cancel_at_period_end), "current_end": _iso(sub.current_end)}


@router.post("/subscription/cancel")
def cancel_my_subscription(request: Request, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Stops future renewals; the paid period already bought stays active until it ends."""
    subs = db.query(BillingSubscription).filter(
        BillingSubscription.organization_id == admin.organization_id,
        BillingSubscription.status.in_(("created", "authenticated", "active", "pending")),
        BillingSubscription.cancel_at_period_end == False,
    ).all()
    if not subs:
        raise HTTPException(status_code=404, detail="No active subscription.")
    for sub in subs:  # includes abandoned checkouts, so nothing can start charging later
        charging = sub.status in ("active", "pending")
        try:
            razorpay.cancel_subscription(sub.provider_subscription_id, at_cycle_end=charging)
        except razorpay.RazorpayError as exc:
            raise _rp_error(exc)
        sub.cancel_at_period_end = True
        if not charging:
            sub.status = "cancelled"
        db.commit()
        record_admin_action(db, organization_id=admin.organization_id, actor=admin.email, action="billing.subscription_cancel",
                            target_type="subscription", target_id=sub.provider_subscription_id,
                            summary="Cancelled the monthly subscription (no further renewals)", request=request)
    return {"cancelled": len(subs), "cancel_at_period_end": True}


# --- Webhook -----------------------------------------------------------------------------------

def _entity(payload: dict, name: str) -> dict:
    return (payload.get(name) or {}).get("entity") or {}


def process_event(db: Session, event: str, payload: dict) -> str:
    """Applies one verified Razorpay event. Returns 'processed' or 'ignored'."""
    pay = _entity(payload, "payment")
    if event in ("payment.captured", "order.paid"):
        order = db.query(BillingOrder).filter(BillingOrder.provider_order_id == pay.get("order_id")).first() if pay.get("order_id") else None
        if order is None or order.kind != "one_time":
            return "ignored"  # subscription payments are handled by subscription.charged
        return "processed" if fulfil_payment(db, pay, order=order, source="webhook") else "ignored"
    if event == "payment.authorized":
        order = db.query(BillingOrder).filter(BillingOrder.provider_order_id == pay.get("order_id")).first() if pay.get("order_id") else None
        if order is None or order.kind != "one_time" or int(pay.get("amount") or 0) != order.amount_minor:
            return "ignored"
        captured = razorpay.capture_payment(pay["id"], order.amount_minor, order.currency)
        return "processed" if fulfil_payment(db, captured, order=order, source="webhook") else "ignored"
    if event == "payment.failed":
        order = db.query(BillingOrder).filter(BillingOrder.provider_order_id == pay.get("order_id")).first() if pay.get("order_id") else None
        if order is None:
            return "ignored"
        mark_failed(db, order, pay.get("error_description") or "Payment failed")
        return "processed"
    if event in ("refund.processed", "refund.created"):
        refund = _entity(payload, "refund")
        pid = pay.get("id") or refund.get("payment_id")
        total = pay.get("amount_refunded")
        if total is None:
            existing = db.query(BillingPayment).filter(BillingPayment.provider_payment_id == pid).first()
            total = (existing.refunded_minor if existing else 0) + int(refund.get("amount") or 0)
        return "processed" if apply_refund(db, pid, int(total)) else "ignored"
    if event.startswith("payment.dispute."):
        dispute = _entity(payload, "dispute")
        pid = dispute.get("payment_id") or pay.get("id")
        phase = event.rsplit(".", 1)[-1]
        phase = {"created": "created", "won": "won", "lost": "lost", "closed": "lost"}.get(phase)
        if not phase:
            return "ignored"
        return "processed" if apply_dispute(db, pid, phase) else "ignored"
    if event.startswith("subscription."):
        sub_e = _entity(payload, "subscription")
        sub = db.query(BillingSubscription).filter(BillingSubscription.provider_subscription_id == sub_e.get("id")).first()
        if sub is None:
            return "ignored"
        sub.status = sub_e.get("status") or sub.status
        sub.current_end = to_dt(sub_e.get("current_end")) or sub.current_end
        if event in ("subscription.cancelled", "subscription.completed"):
            sub.cancel_at_period_end = True
        db.commit()
        if event == "subscription.charged" and pay:
            fulfil_payment(db, pay, subscription=sub, source="webhook")
        return "processed"
    return "ignored"


@router.post("/razorpay/webhook")
async def razorpay_webhook(request: Request, db: Session = Depends(get_db)):
    """Razorpay → AgentShield. Rejected unless the HMAC signature matches; each event id is applied once."""
    raw = await request.body()
    if not razorpay.verify_webhook(raw, request.headers.get("X-Razorpay-Signature")):
        logger.warning("Rejected a webhook with an invalid signature")
        raise HTTPException(status_code=400, detail="Invalid signature.")
    try:
        body = json.loads(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid JSON.")
    event = str(body.get("event") or "")
    event_id = request.headers.get("X-Razorpay-Event-Id") or f"sha256:{hashlib.sha256(raw).hexdigest()[:64]}"

    row = db.query(WebhookEvent).filter(WebhookEvent.provider_event_id == event_id).first()
    if row and row.status in ("processed", "ignored"):
        return {"status": "duplicate"}
    if row is None:
        row = WebhookEvent(provider_event_id=event_id[:80], event=event[:60])
        db.add(row)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            return {"status": "duplicate"}  # a concurrent delivery of the same event
    try:
        outcome = process_event(db, event, body.get("payload") or {})
        row.status, row.error, row.processed_at = outcome, None, utcnow()
        db.commit()
    except Exception as exc:  # let Razorpay retry; the retry reprocesses this event
        db.rollback()
        row = db.query(WebhookEvent).filter(WebhookEvent.provider_event_id == event_id[:80]).first()
        if row:
            row.status, row.error = "failed", str(exc)[:500]
            db.commit()
        logger.exception("Webhook %s failed", event)
        raise HTTPException(status_code=500, detail="Processing failed; retry later.")
    return {"status": outcome}


# --- Internal console (staff) ------------------------------------------------------------------

@platform_router.get("/orders")
def all_orders(staff: StaffUser = Depends(require_staff("billing.read")), db: Session = Depends(get_db)):
    names = dict(db.query(Organization.id, Organization.name).all())
    out = []
    for o in db.query(BillingOrder).order_by(BillingOrder.created_at.desc()).limit(300).all():
        row = _order_out(o, db.query(BillingPayment).filter(BillingPayment.order_id == o.id).all())
        row["organization"] = names.get(o.organization_id)
        out.append(row)
    return out


@platform_router.get("/webhooks")
def recent_webhooks(staff: StaffUser = Depends(require_staff("billing.read")), db: Session = Depends(get_db)):
    return [
        {"event": w.event, "provider_event_id": w.provider_event_id, "status": w.status, "error": w.error,
         "received_at": _iso(w.received_at), "processed_at": _iso(w.processed_at)}
        for w in db.query(WebhookEvent).order_by(WebhookEvent.received_at.desc()).limit(200).all()
    ]


class RefundRequest(BaseModel):
    reason: str = Field(..., min_length=3, max_length=255)
    amount_minor: Optional[int] = Field(default=None, ge=1)


@platform_router.post("/payments/{payment_id}/refund")
def refund(payment_id: str, body: RefundRequest, request: Request, staff: StaffUser = Depends(require_staff("billing.refund")),
           db: Session = Depends(get_db)):
    """Asks Razorpay to refund. The licence changes when Razorpay confirms the refund (webhook)."""
    p = db.query(BillingPayment).filter(BillingPayment.id == payment_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Payment not found.")
    remaining = p.amount_minor - (p.refunded_minor or 0)
    amount = body.amount_minor or remaining
    if amount <= 0 or amount > remaining:
        raise HTTPException(status_code=400, detail="Refund amount exceeds what is left to refund.")
    try:
        result = razorpay.refund_payment(p.provider_payment_id, amount, {"reason": body.reason, "by": staff.email})
    except razorpay.RazorpayError as exc:
        raise _rp_error(exc)
    record_admin_action(db, organization_id=p.organization_id, actor=f"staff:{staff.email}", action="billing.refund_requested",
                        target_type="payment", target_id=p.provider_payment_id,
                        summary=f"Requested refund of {amount / 100:.2f} {p.currency}: {body.reason}", request=request, actor_type="staff")
    if result.get("status") == "processed":
        apply_refund(db, p.provider_payment_id, (p.refunded_minor or 0) + amount, source="platform")
    return {"refund_id": result.get("id"), "status": result.get("status")}


@platform_router.post("/reconcile")
def reconcile(request: Request, staff: StaffUser = Depends(require_staff("billing.reconcile")), db: Session = Depends(get_db)):
    """Re-checks recent unpaid orders with Razorpay and completes any payment whose webhook was missed."""
    since = utcnow() - timedelta(days=7)
    fixed, checked = 0, 0
    for order in db.query(BillingOrder).filter(BillingOrder.kind == "one_time", BillingOrder.status.in_(("created", "failed")),
                                               BillingOrder.provider_order_id.isnot(None), BillingOrder.created_at >= since).all():
        checked += 1
        try:
            for pay in razorpay.order_payments(order.provider_order_id):
                if pay.get("status") == "authorized":
                    pay = razorpay.capture_payment(pay["id"], order.amount_minor, order.currency)
                if pay.get("status") == "captured" and fulfil_payment(db, pay, order=order, source="reconcile"):
                    fixed += 1
                    break
        except razorpay.RazorpayError as exc:
            raise _rp_error(exc)
    record_admin_action(db, organization_id=None, actor=f"staff:{staff.email}", action="billing.reconcile",
                        target_type="job", target_id="reconcile", summary=f"Reconciled {checked} orders, completed {fixed}",
                        request=request, actor_type="staff")
    return {"checked": checked, "completed": fixed}
