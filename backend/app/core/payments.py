"""Payment business rules: turning *confirmed* payments into licences, and refunds/disputes back.

Rules:
- Only a payment the provider reports as `captured`, for exactly the order's amount and currency,
  creates or extends a licence. A browser saying "paid" is never enough: the checkout callback is
  verified by signature AND by fetching the payment from Razorpay (api/payments.py), and webhooks
  are verified by HMAC.
- Idempotent: BillingPayment.provider_payment_id is UNIQUE, so the webhook, the checkout callback,
  reconciliation and duplicate deliveries can all run for the same payment and only one licence
  is created. A paid licence bought while another is running starts when the current one ends.
- A full refund or an opened dispute revokes the licence it created; a won dispute restores it;
  a partial refund keeps it.
"""
import logging
import secrets
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.audit import record_admin_action
from app.core.entitlements import grant_license, utcnow
from app.core.usage import add_credits
from app.db.models import BillingOrder, BillingPayment, BillingSubscription, CreditLedger, License, Notification, Plan

logger = logging.getLogger("agentshield.payments")


def new_receipt_number() -> str:
    return f"AS-{utcnow().strftime('%Y%m')}-{secrets.token_hex(3).upper()}"


def _notify(db: Session, org_id: str, kind: str, title: str, body: str) -> None:
    db.add(Notification(organization_id=org_id, license_id=None, kind=kind, title=title, body=body))


def fulfil_payment(
    db: Session, payment: dict, *, order: Optional[BillingOrder] = None,
    subscription: Optional[BillingSubscription] = None, source: str = "webhook",
) -> Optional[BillingPayment]:
    """Records a captured payment and grants its licence exactly once. Returns the payment row, or None if refused."""
    pid = str(payment.get("id") or "")
    if not pid:
        return None
    existing = db.query(BillingPayment).filter(BillingPayment.provider_payment_id == pid).first()
    if existing:
        return existing  # already fulfilled (duplicate webhook, callback after webhook, reconciliation...)
    if payment.get("status") != "captured":
        return None

    if subscription is not None:
        org_id, plan_code = subscription.organization_id, subscription.plan_code
        order = order or db.query(BillingOrder).filter(BillingOrder.provider_subscription_id == subscription.provider_subscription_id).first()
    elif order is not None:
        org_id, plan_code = order.organization_id, order.plan_code
        if payment.get("order_id") and order.provider_order_id and payment.get("order_id") != order.provider_order_id:
            logger.warning("Payment %s belongs to another order", pid)
            return None
    else:
        return None

    plan = db.query(Plan).filter(Plan.code == plan_code).first()
    expected_amount = order.amount_minor if order is not None else (plan.razorpay_plan_amount or plan.price_minor)
    expected_currency = order.currency if order is not None else plan.currency
    if int(payment.get("amount") or 0) != int(expected_amount or -1) or str(payment.get("currency", "")).upper() != expected_currency:
        if order is not None and order.status == "created":
            order.failure_reason = "Paid amount or currency does not match the order"
            db.commit()
        record_admin_action(
            db, organization_id=org_id, actor=f"payments:{source}", actor_type="system", action="billing.amount_mismatch",
            target_type="payment", target_id=pid,
            summary=f"Payment {pid} ignored: {payment.get('amount')} {payment.get('currency')} != {expected_amount} {expected_currency}",
        )
        return None

    receipt = new_receipt_number()
    row = BillingPayment(
        organization_id=org_id, order_id=order.id if order else None, provider_payment_id=pid,
        amount_minor=int(payment["amount"]), currency=expected_currency, method=payment.get("method"),
        status="captured", receipt_number=receipt,
    )
    db.add(row)
    try:
        db.flush()  # UNIQUE(provider_payment_id) stops a concurrent duplicate here
        if plan.kind == "CREDITS":
            # Pay as you go: a verified payment adds the pack's prompt checks to the prepaid balance
            balance = add_credits(db, org_id, int(plan.credits or 0), "purchase", reference=pid,
                                  note=f"{plan.name} (receipt {receipt})", created_by=f"payments:{source}")
            message = f"Thank you. {int(plan.credits or 0):,} prompt checks were added; your balance is {balance:,}. Receipt {receipt}."
        else:
            licence = grant_license(db, org_id, plan, f"payment:{pid}", payment_ref=pid)
            row.license_id = licence.id
            message = (f"Thank you. Your AgentShield plan ({plan.name}) is active until "
                       f"{licence.expires_at.strftime('%d %b %Y') if licence.expires_at else 'further notice'}. Receipt {receipt}.")
        if order is not None and order.status in ("created", "failed"):
            order.status = "paid"
            order.paid_at = utcnow()
            order.failure_reason = None
            order.receipt_number = order.receipt_number or receipt
        _notify(db, org_id, f"payment_{pid}", "Payment received", message)
        db.commit()
    except IntegrityError:
        db.rollback()
        return db.query(BillingPayment).filter(BillingPayment.provider_payment_id == pid).first()
    record_admin_action(
        db, organization_id=org_id, actor=f"payments:{source}", actor_type="system", action="billing.payment_captured",
        target_type="payment", target_id=pid,
        summary=f"Payment {pid} ({row.amount_minor / 100:.2f} {row.currency}) activated {plan.name}",
    )
    return row


def _credits_of(db: Session, payment: BillingPayment) -> int:
    """Credits a payment added (credit-pack purchases), from the ledger."""
    row = db.query(CreditLedger).filter(CreditLedger.reference == payment.provider_payment_id, CreditLedger.kind == "purchase").first()
    return int(row.delta) if row else 0


def _revoke_licence_of(db: Session, payment: BillingPayment, reason: str) -> None:
    credits = _credits_of(db, payment)
    if credits:
        # Credits already used cannot be taken back; the balance never goes below zero
        add_credits(db, payment.organization_id, -credits, "dispute" if "disput" in reason.lower() else "refund",
                    reference=payment.provider_payment_id, note=reason, created_by="payments")
    if not payment.license_id:
        return
    licence = db.query(License).filter(License.id == payment.license_id).first()
    if licence and licence.status == "ACTIVE":
        licence.status = "REVOKED"
        licence.revoked_at = utcnow()
        licence.revoked_by = "payments"
        licence.revoked_reason = reason


def apply_refund(db: Session, provider_payment_id: str, refunded_total_minor: int, source: str = "webhook") -> Optional[BillingPayment]:
    """Sets the payment's refunded total (authoritative value from the provider)."""
    payment = db.query(BillingPayment).filter(BillingPayment.provider_payment_id == provider_payment_id).first()
    if not payment:
        return None
    payment.refunded_minor = max(payment.refunded_minor or 0, int(refunded_total_minor or 0))
    order = db.query(BillingOrder).filter(BillingOrder.id == payment.order_id).first() if payment.order_id else None
    if payment.refunded_minor >= payment.amount_minor:
        payment.status = "refunded"
        _revoke_licence_of(db, payment, "Payment refunded")
        if order and order.kind == "one_time":
            order.status = "refunded"
        _notify(db, payment.organization_id, f"refund_{provider_payment_id}", "Payment refunded",
                f"Payment {payment.receipt_number} was refunded in full, so the plan it paid for has ended.")
    elif payment.refunded_minor > 0:
        payment.status = "partially_refunded"
        if order and order.kind == "one_time":
            order.status = "partially_refunded"
    db.commit()
    record_admin_action(
        db, organization_id=payment.organization_id, actor=f"payments:{source}", actor_type="system", action="billing.refund",
        target_type="payment", target_id=provider_payment_id,
        summary=f"Refund recorded: {payment.refunded_minor / 100:.2f} of {payment.amount_minor / 100:.2f} {payment.currency} ({payment.status})",
    )
    return payment


def apply_dispute(db: Session, provider_payment_id: str, phase: str, source: str = "webhook") -> Optional[BillingPayment]:
    """phase: created (licence suspended), won (restored), lost/closed (stays revoked)."""
    payment = db.query(BillingPayment).filter(BillingPayment.provider_payment_id == provider_payment_id).first()
    if not payment:
        return None
    if phase == "created":
        payment.status = "disputed"
        _revoke_licence_of(db, payment, "Payment disputed")
    elif phase == "won" and payment.status == "disputed":
        payment.status = "captured"
        taken = db.query(CreditLedger).filter(CreditLedger.reference == payment.provider_payment_id, CreditLedger.kind == "dispute").first()
        if taken and taken.delta < 0:
            add_credits(db, payment.organization_id, -int(taken.delta), "dispute_won", reference=payment.provider_payment_id,
                        note="Dispute won: credits restored", created_by="payments")
        licence = db.query(License).filter(License.id == payment.license_id).first() if payment.license_id else None
        if licence and licence.revoked_reason == "Payment disputed":
            licence.status, licence.revoked_at, licence.revoked_by, licence.revoked_reason = "ACTIVE", None, None, None
    db.commit()
    record_admin_action(
        db, organization_id=payment.organization_id, actor=f"payments:{source}", actor_type="system", action=f"billing.dispute_{phase}",
        target_type="payment", target_id=provider_payment_id, summary=f"Dispute {phase} for payment {provider_payment_id}",
    )
    return payment


def mark_failed(db: Session, order: BillingOrder, reason: str) -> None:
    if order.status == "created":
        order.status = "failed"
        order.failure_reason = (reason or "Payment failed")[:255]
        db.commit()


def has_auto_renewal(db: Session, organization_id: str) -> bool:
    """An active recurring subscription that is not set to cancel renews by itself (no expiry reminders needed)."""
    return db.query(BillingSubscription).filter(
        BillingSubscription.organization_id == organization_id,
        BillingSubscription.status.in_(("active", "authenticated")),
        BillingSubscription.cancel_at_period_end == False,
    ).first() is not None


def to_dt(epoch: Optional[int]) -> Optional[datetime]:
    return datetime.fromtimestamp(int(epoch), tz=timezone.utc) if epoch else None
