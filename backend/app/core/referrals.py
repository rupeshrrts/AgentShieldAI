"""Referrals ("invite a friend").

- Every individual account has a random referral code (created on first use), shared as a portal link
  `<dashboard>/#ref=<code>`.
- Sign-up may carry `referral_code`; an unknown code, a company workspace or the same person (same
  normalized email) is ignored, so sign-up never fails because of it. One referral per new account.
- When the invited person confirms their email (api/auth.py verify_email), both accounts get
  REFERRAL_BONUS_CHECKS bonus prompt checks as credits (ledger kind `referral`) and an in-app notice.
  An account is rewarded for at most REFERRAL_MAX referrals; later ones are recorded as NOT_REWARDED
  (neither side gets the bonus). Rewarding is a conditional UPDATE, so it happens once.
"""
import secrets
from typing import Optional

from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import abuse
from app.core.config import settings
from app.core.entitlements import utcnow
from app.core.usage import add_credits
from app.db.models import Notification, Organization, Referral, User

_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no look-alike characters


def referral_code_for(db: Session, org: Organization) -> str:
    """The account's referral code, created (and committed) on first use."""
    if org.referral_code:
        return org.referral_code
    for _ in range(5):
        org.referral_code = "".join(secrets.choice(_ALPHABET) for _ in range(10))
        try:
            db.commit()
            return org.referral_code
        except IntegrityError:  # code taken (practically never)
            db.rollback()
    raise RuntimeError("Could not create a referral code.")


def _admin(db: Session, organization_id: str) -> Optional[User]:
    return db.query(User).filter(User.organization_id == organization_id, User.role == "ADMIN").order_by(User.created_at.asc()).first()


def record_signup_referral(db: Session, code: Optional[str], new_org: Organization, new_email: str) -> Optional[Referral]:
    """Links a new individual account to the account whose code it signed up with. Caller commits."""
    code = (code or "").strip().lower()
    if not code or (new_org.account_type or "") != "INDIVIDUAL":
        return None
    referrer = db.query(Organization).filter(Organization.referral_code == code).first()
    if referrer is None or referrer.id == new_org.id or referrer.account_type != "INDIVIDUAL" or referrer.suspended_at is not None:
        return None
    owner = _admin(db, referrer.id)
    if owner is not None and abuse.normalize_email(owner.email) == abuse.normalize_email(new_email):
        return None  # no self-referral
    row = Referral(referrer_org_id=referrer.id, referred_org_id=new_org.id, status="PENDING")
    db.add(row)
    return row


def _notice(db: Session, org_id: str, referral_id: str, title: str, body: str) -> None:
    db.add(Notification(organization_id=org_id, license_id=None, kind=f"referral_{referral_id[:12]}", title=title, body=body))


def reward_on_confirmation(db: Session, user: User) -> bool:
    """Rewards the referral of this user's account once their email is confirmed. Returns True if rewarded."""
    ref = db.query(Referral).filter(Referral.referred_org_id == user.organization_id, Referral.status == "PENDING").first()
    if ref is None:
        return False
    referrer = db.query(Organization).filter(Organization.id == ref.referrer_org_id).first()
    owner = _admin(db, ref.referrer_org_id)
    rewarded = db.query(Referral).filter(Referral.referrer_org_id == ref.referrer_org_id, Referral.status == "REWARDED").count()
    same_person = owner is not None and abuse.normalize_email(owner.email) == abuse.normalize_email(user.email)
    eligible = referrer is not None and referrer.suspended_at is None and not same_person and rewarded < settings.REFERRAL_MAX
    new_status = "REWARDED" if eligible else "NOT_REWARDED"
    res = db.execute(update(Referral).where(Referral.id == ref.id, Referral.status == "PENDING")
                     .values(status=new_status, rewarded_at=utcnow() if eligible else None))
    if res.rowcount != 1 or not eligible:
        db.commit()
        return False
    bonus = settings.REFERRAL_BONUS_CHECKS
    add_credits(db, ref.referrer_org_id, bonus, "referral", reference=f"referral:{ref.id[:12]}",
                note="Bonus prompt checks: a friend you invited joined", created_by="system")
    add_credits(db, ref.referred_org_id, bonus, "referral", reference=f"referral:{ref.id[:12]}",
                note="Bonus prompt checks for joining from an invite", created_by="system")
    _notice(db, ref.referrer_org_id, ref.id, f"You earned {bonus} bonus prompt checks",
            f"Someone you invited confirmed their email, so {bonus} bonus prompt checks were added to your account. "
            f"You can be rewarded for up to {settings.REFERRAL_MAX} invites.")
    _notice(db, ref.referred_org_id, ref.id, f"Welcome bonus: {bonus} prompt checks",
            f"You joined from an invite, so {bonus} bonus prompt checks were added to your account. "
            "They are used after your free monthly checks and never expire.")
    db.commit()
    return True


def referral_summary(db: Session, org: Organization) -> dict:
    rows = db.query(Referral).filter(Referral.referrer_org_id == org.id).all()
    rewarded = sum(1 for r in rows if r.status == "REWARDED")
    return {
        "code": referral_code_for(db, org),
        "invited": len(rows),
        "pending": sum(1 for r in rows if r.status == "PENDING"),
        "rewarded": rewarded,
        "max_rewarded": settings.REFERRAL_MAX,
        "bonus_checks": settings.REFERRAL_BONUS_CHECKS,
        "bonus_earned": rewarded * settings.REFERRAL_BONUS_CHECKS,
    }
