"""Usage metering and prepaid credits.

Billable unit: one PROMPT CHECK = one prompt the extension inspected on an AI site, reported by an
activated browser (POST /api/v1/events). Website blocks (dlp.* rules) and file uploads are not counted.

- Each extension event carries a random client_event_id; the server stores it with a unique
  constraint, so retries and offline-queue replays are counted once.
- A check is covered by the licence while the plan's monthly check_limit (if any) is not used up;
  otherwise it is paid with one prepaid credit. The credit is taken with a single atomic UPDATE
  (credit_balance = credit_balance - 1 WHERE credit_balance > 0), so concurrent requests cannot
  spend the same credit twice or drive the balance below zero.
- Access itself is decided on every request by core/entitlements.py (CREDITS_ACTIVE, LIMIT_REACHED,
  CAP_REACHED, NO_CREDITS); this module only records what happened.
"""
from typing import Optional

from sqlalchemy import text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.entitlements import current_entitlement, utcnow
from app.db.models import CreditLedger, Notification, Organization, UsageDaily


def is_prompt_check(rule_id: str, outcome: str) -> bool:
    rule_id = (rule_id or "").lower()
    outcome = (outcome or "").lower()
    return not rule_id.startswith("dlp.") and not outcome.startswith("file_") and outcome != "navigation_blocked"


def _usage_row(db: Session, organization_id: str, email: str, day: str) -> UsageDaily:
    row = db.query(UsageDaily).filter(UsageDaily.organization_id == organization_id, UsageDaily.user_email == email,
                                      UsageDaily.day == day).first()
    if row is not None:
        return row
    row = UsageDaily(organization_id=organization_id, user_email=email, day=day, prompt_checks=0, credit_checks=0,
                     blocked=0, warned=0, redacted=0)
    db.add(row)
    try:
        db.flush()
    except IntegrityError:  # created concurrently
        db.rollback()
        row = db.query(UsageDaily).filter(UsageDaily.organization_id == organization_id, UsageDaily.user_email == email,
                                          UsageDaily.day == day).first()
    return row


def take_credit(db: Session, organization_id: str) -> Optional[int]:
    """Atomically spends one credit. Returns the new balance, or None if there was none."""
    res = db.execute(
        update(Organization)
        .where(Organization.id == organization_id, Organization.credit_balance > 0)
        .values(credit_balance=Organization.credit_balance - 1)
    )
    if res.rowcount != 1:
        return None
    return int(db.execute(text("SELECT credit_balance FROM organizations WHERE id = :id"), {"id": organization_id}).scalar() or 0)


def _last_purchase(db: Session, organization_id: str) -> Optional[CreditLedger]:
    return (db.query(CreditLedger).filter(CreditLedger.organization_id == organization_id, CreditLedger.delta > 0)
            .order_by(CreditLedger.created_at.desc()).first())


def _low_balance_notice(db: Session, organization_id: str, balance: int) -> None:
    """One in-app notice per top-up when credits run low, and when they run out."""
    last = _last_purchase(db, organization_id)
    if last is None:
        return
    threshold = max(10, (last.delta or 0) // 10)
    if balance == threshold:
        kind, title = f"credits_low_{last.id[:8]}", "Your credits are running low"
        body = f"{balance} prompt checks left. Buy more credits so protection continues without interruption."
    elif balance == 0:
        kind, title = f"credits_out_{last.id[:8]}", "Your credits are used up"
        body = "Protection is paused on your browsers until you buy credits or choose a plan."
    else:
        return
    if not db.query(Notification).filter(Notification.organization_id == organization_id, Notification.kind == kind).first():
        db.add(Notification(organization_id=organization_id, license_id=None, kind=kind, title=title, body=body))


def record_check(db: Session, organization_id: str, email: str, action: str) -> dict:
    """Meters one prompt check (call once per newly stored event). Commits."""
    now = utcnow()
    ent = current_entitlement(db, organization_id, now)
    row = _usage_row(db, organization_id, email or "", now.strftime("%Y-%m-%d"))
    row.prompt_checks = (row.prompt_checks or 0) + 1
    action = (action or "").upper()
    if action == "BLOCK":
        row.blocked = (row.blocked or 0) + 1
    elif action == "WARN":
        row.warned = (row.warned or 0) + 1
    elif action == "REDACT":
        row.redacted = (row.redacted or 0) + 1
    paid_with_credit = False
    if ent.pay_with_credits:
        balance = take_credit(db, organization_id)
        if balance is not None:
            paid_with_credit = True
            row.credit_checks = (row.credit_checks or 0) + 1
            _low_balance_notice(db, organization_id, balance)
    db.commit()
    return {"paid_with_credit": paid_with_credit}


def add_credits(db: Session, organization_id: str, delta: int, kind: str, *, reference: Optional[str] = None,
                note: Optional[str] = None, created_by: Optional[str] = None) -> int:
    """Changes the balance (never below zero) and writes the ledger. Returns the new balance. Caller commits."""
    org = db.query(Organization).filter(Organization.id == organization_id).with_for_update().first()
    new_balance = max(0, int(org.credit_balance or 0) + int(delta))
    applied = new_balance - int(org.credit_balance or 0)
    org.credit_balance = new_balance
    db.add(CreditLedger(organization_id=organization_id, delta=applied, kind=kind, reference=reference, note=note,
                        balance_after=new_balance, created_by=created_by))
    db.flush()
    return new_balance
