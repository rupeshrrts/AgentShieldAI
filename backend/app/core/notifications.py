"""Licence reminders: in-app notices (and email to the company's admins) at 7, 3 and 1 days
before a licence ends, and when it has ended.

Idempotent: UNIQUE(license_id, kind) means running the job twice, or on several servers,
never sends the same reminder twice. Only the most urgent reminder that applies is sent
(a trial extended to 2 days left gets the 3-day notice, not 7 and 3 together).
This job only informs; access is enforced on every request by core/entitlements.py.
"""
import asyncio
import logging
from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.email import send_email
from app.core.entitlements import aware, current_entitlement, utcnow
from app.core.payments import has_auto_renewal
from app.db.models import License, Notification, Organization, User

logger = logging.getLogger("agentshield.reminders")

THRESHOLDS = (1, 3, 7)  # days


def _admins(db: Session, organization_id: str) -> List[User]:
    return db.query(User).filter(
        User.organization_id == organization_id, User.active == True, User.role == "ADMIN"
    ).all()


def _notify(db: Session, org_id: str, licence: License, kind: str, title: str, body: str) -> bool:
    note = Notification(organization_id=org_id, license_id=licence.id, kind=kind, title=title, body=body)
    db.add(note)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return False  # already sent
    for admin in _admins(db, org_id):
        try:
            send_email(admin.email, f"AgentShield: {title}", body)
            note.emailed = True
        except Exception:
            logger.warning("Reminder email to %s failed", admin.email)
    db.commit()
    return True


def run_reminders(db: Session, now: Optional[datetime] = None) -> int:
    """Creates due reminders. Returns how many new notices were created."""
    now = now or utcnow()
    created = 0
    for org in db.query(Organization).filter(Organization.suspended_at.is_(None)).all():
        ent = current_entitlement(db, org.id, now)
        if ent.kind == "FREE":
            # An individual's trial or plan ended and the account moved to the Free plan (it is not locked)
            ended = ent.extra.get("ended_licence")
            if ended is not None:
                label = "free trial" if ended.kind == "TRIAL" else "AgentShield plan"
                limit = f"{ent.check_limit} prompt checks a month" if ent.check_limit else "free prompt checks"
                if _notify(
                    db, org.id, ended, "expired",
                    f"Your {label} has ended: you moved to the Free plan",
                    f"Your {label} for {org.name} has ended, so your account moved to the Free plan: {limit} "
                    f"on {ent.device_limit} browser{'s' if ent.device_limit != 1 else ''}. Browsers stay connected. When the "
                    "free checks are used up, prompt checks pause until the 1st of the month. Choose a plan or buy credits in "
                    "the AgentShield portal for more.",
                ):
                    created += 1
            continue
        licence = ent.license
        if licence is None or licence.expires_at is None:
            continue
        label = "free trial" if licence.kind == "TRIAL" else "AgentShield plan"
        individual = (org.account_type or "COMPANY") == "INDIVIDUAL"
        if ent.active and licence.kind == "PAID" and has_auto_renewal(db, org.id):
            continue  # renews by itself; a failed renewal is reported by the payment provider events
        if ent.active:
            left = aware(licence.expires_at) - now
            due = [t for t in THRESHOLDS if left <= timedelta(days=t)]
            if not due:
                continue
            days = min(due)
            # Skip if this or a more urgent reminder was already sent for this licence
            sent = {n.kind for n in db.query(Notification).filter(Notification.license_id == licence.id).all()}
            if any(f"expires_{t}d" in sent for t in THRESHOLDS if t <= days):
                continue
            ends = aware(licence.expires_at).strftime("%d %b %Y %H:%M UTC")
            if _notify(
                db, org.id, licence, f"expires_{days}d",
                f"Your {label} ends in {days} day{'s' if days != 1 else ''}",
                f"Your {label} for {org.name} ends on {ends}. Choose a plan in the AgentShield portal so protection "
                + ("continues without interruption. Browsers stay connected; afterwards your account moves to the Free plan "
                   "with a monthly limit of prompt checks." if individual else
                   "continues without interruption. Browsers stay connected; they are locked only if the plan ends."),
            ):
                created += 1
        elif ent.state == "EXPIRED":
            if _notify(
                db, org.id, licence, "expired",
                f"Your {label} has ended",
                f"Your {label} for {org.name} has ended, so AgentShield browsers are locked and AI sites are blocked. "
                "Choose a plan in the AgentShield portal; browsers resume automatically once it is active.",
            ):
                created += 1
    return created


async def reminder_loop(session_factory, interval_seconds: int = 3600) -> None:
    """Background task started by main.py (hourly; first run a minute after startup)."""
    await asyncio.sleep(60)
    while True:
        try:
            db = session_factory()
            try:
                run_reminders(db)
            finally:
                db.close()
        except Exception:
            logger.exception("Reminder job failed")
        await asyncio.sleep(interval_seconds)
