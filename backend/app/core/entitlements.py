"""Licences and entitlement: the single place that decides whether a company may use the extension.

Every decision uses the server's clock and the licences stored in the database; nothing the
browser sends (dates, flags, cached states) is trusted. It is evaluated on every protected
request (device activation, session issue, and every extension API call), not by a scheduled job.

States:
  TRIAL_ACTIVE / SUBSCRIPTION_ACTIVE  - an active licence covers "now" (and its monthly check limit, if any,
                                         is not used up, or prepaid credits cover the extra checks)
  CREDITS_ACTIVE                       - no licence covers "now", but prepaid credits remain (pay as you go)
  FREE_ACTIVE                          - free forever (individual account, confirmed email, no live licence):
                                         the "free" plan's monthly prompt checks (then credits, if any)
  FREE_PAUSED                          - free account whose monthly free checks (or own monthly limit) are
                                         used up and no credits: the browser stays connected and AI sites
                                         stay usable, but prompt checks pause until the 1st (UTC) or an upgrade
  LIMIT_REACHED                       - the plan's monthly prompt checks are used up and there are no credits
  CAP_REACHED                          - the account's own monthly limit (spend cap) is reached
  NO_CREDITS                           - pay-as-you-go account whose credits ran out (and no licence)
  EXPIRED                              - the account had a licence, but none covers "now"
  NONE                                 - never had a licence or credits (claim a trial, buy a plan or credits)
  REVOKED                              - its licences were revoked by AgentShieldAI
  SUSPENDED                            - the account is suspended

Usage (prompt checks) is counted per UTC calendar month from usage_daily (core/usage.py).
"""
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.models import Computer, CreditLedger, Device, License, Organization, Plan, UsageDaily, User

FREE_PLAN_CODE = "free"
# Prompt checks run (the extension inspects prompts and meters them)
ACTIVE_STATES = ("TRIAL_ACTIVE", "SUBSCRIPTION_ACTIVE", "CREDITS_ACTIVE", "FREE_ACTIVE")
# The browser may stay connected (device sessions, activation). FREE_PAUSED keeps its session so it
# resumes by itself on the 1st or after an upgrade; only prompt checks pause.
ACCESS_STATES = ACTIVE_STATES + ("FREE_PAUSED",)

# Error codes returned to the extension (detail.code) when an account is not entitled
DENIAL_CODES = {
    "NONE": ("NO_LICENSE", "No active plan. Choose the Free plan, start the free trial, choose a paid plan or buy credits in the AgentShield portal."),
    "EXPIRED": ("LICENSE_EXPIRED", "Your AgentShield plan has expired. Renew it or buy credits in the AgentShield portal."),
    "REVOKED": ("LICENSE_REVOKED", "Your AgentShield licence was revoked. Contact support."),
    "SUSPENDED": ("ORG_SUSPENDED", "Your AgentShield account is suspended. Contact support."),
    "LIMIT_REACHED": ("USAGE_LIMIT", "This month's included prompt checks are used up. Buy credits or upgrade in the AgentShield portal."),
    "CAP_REACHED": ("SPEND_CAP", "Your monthly usage limit is reached. Raise it in the AgentShield portal to continue."),
    "NO_CREDITS": ("NO_CREDITS", "Your prepaid credits are used up. Buy more credits or choose a plan in the AgentShield portal."),
}


def month_start(now: datetime) -> str:
    return now.strftime("%Y-%m-01")


def next_month_start(now: datetime) -> datetime:
    """00:00 UTC on the 1st of next month (when monthly prompt checks reset)."""
    now = now.astimezone(timezone.utc) if now.tzinfo else now.replace(tzinfo=timezone.utc)
    return datetime(now.year + (now.month // 12), now.month % 12 + 1, 1, tzinfo=timezone.utc)


def month_usage(db: Session, organization_id: str, now: datetime) -> tuple:
    """(prompt checks this UTC month, of which paid with credits)."""
    row = db.query(func.coalesce(func.sum(UsageDaily.prompt_checks), 0), func.coalesce(func.sum(UsageDaily.credit_checks), 0)).filter(
        UsageDaily.organization_id == organization_id, UsageDaily.day >= month_start(now),
    ).one()
    return int(row[0] or 0), int(row[1] or 0)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def add_months(start: datetime, months: int) -> datetime:
    """Calendar months (e.g. 31 Jan + 1 month = 28/29 Feb)."""
    month = start.month - 1 + months
    year = start.year + month // 12
    month = month % 12 + 1
    days_in_month = [31, 29 if (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return start.replace(year=year, month=month, day=min(start.day, days_in_month[month - 1]))


def plan_end(plan: Plan, start: datetime) -> Optional[datetime]:
    if plan.kind == "INTERNAL":
        return None
    if plan.duration_months:
        return add_months(start, plan.duration_months)
    return start + timedelta(days=plan.duration_days or 30)


@dataclass
class Entitlement:
    state: str
    license: Optional[License] = None
    plan_code: Optional[str] = None
    kind: Optional[str] = None
    expires_at: Optional[datetime] = None
    device_limit: int = 0
    devices_used: int = 0
    last_expired_at: Optional[datetime] = None
    credit_balance: int = 0
    checks_this_month: int = 0
    included_checks_used: int = 0             # this month's checks covered by the licence (not credits)
    check_limit: Optional[int] = None         # licence's monthly included checks (None = unlimited)
    monthly_cap: Optional[int] = None         # account's own monthly limit
    pay_with_credits: bool = False            # the next prompt check is paid with a credit
    extra: dict = field(default_factory=dict)

    @property
    def active(self) -> bool:
        """Prompt checks run."""
        return self.state in ACTIVE_STATES

    @property
    def allowed(self) -> bool:
        """The browser may stay connected (includes FREE_PAUSED)."""
        return self.state in ACCESS_STATES

    @property
    def checks_paused(self) -> bool:
        return self.state == "FREE_PAUSED"

    def days_left(self, now: Optional[datetime] = None) -> Optional[int]:
        if self.state not in ("TRIAL_ACTIVE", "SUBSCRIPTION_ACTIVE") or self.expires_at is None:
            return None
        seconds = (aware(self.expires_at) - (now or utcnow())).total_seconds()
        return max(0, int((seconds + 86399) // 86400))

    def as_dict(self, now: Optional[datetime] = None) -> dict:
        monthly = self.state in ("FREE_ACTIVE", "FREE_PAUSED", "LIMIT_REACHED", "CAP_REACHED")
        return {
            "checks_paused": self.checks_paused,
            # When this month's prompt checks reset (monthly limits only)
            "resets_at": next_month_start(now or utcnow()).isoformat() if monthly else None,
            "state": self.state,
            "plan_code": self.plan_code,
            "kind": self.kind,
            "expires_at": aware(self.expires_at).isoformat() if self.expires_at else None,
            "days_left": self.days_left(now),
            "device_limit": self.device_limit,
            "devices_used": self.devices_used,
            "last_expired_at": aware(self.last_expired_at).isoformat() if self.last_expired_at else None,
            "credit_balance": self.credit_balance,
            "checks_this_month": self.checks_this_month,
            "included_checks_used": self.included_checks_used,
            "check_limit": self.check_limit,
            "monthly_cap": self.monthly_cap,
            "pay_with_credits": self.pay_with_credits,
        }


def active_device_count(db: Session, organization_id: str) -> int:
    """Device slots in use: each browser connected on its own, plus each PC connected through the
    AgentShield Windows app (its browsers are included in the PC's one slot)."""
    browsers = db.query(Device).filter(
        Device.organization_id == organization_id, Device.status != "REVOKED", Device.computer_id.is_(None),
    ).count()
    computers = db.query(Computer).filter(Computer.organization_id == organization_id, Computer.status == "ACTIVE").count()
    return browsers + computers


def user_slot_count(db: Session, user_id: str) -> int:
    """The same count for one person (MAX_DEVICES_PER_USER)."""
    browsers = db.query(Device).filter(
        Device.user_id == user_id, Device.status != "REVOKED", Device.computer_id.is_(None),
    ).count()
    return browsers + db.query(Computer).filter(Computer.user_id == user_id, Computer.status == "ACTIVE").count()


def free_plan_for(db: Session, org: Organization, licences: list) -> Optional[Plan]:
    """The free plan when this account qualifies for free forever (computed; there is no licence row):
    an INDIVIDUAL account that chose the Free plan (or whose trial or paid plan ended), with an active admin
    (who confirmed their email when EMAIL_VERIFICATION_REQUIRED),
    not revoked by AgentShieldAI, while FREE_TIER_ENABLED and the "free" plan is active. Callers check that
    no licence covers "now"."""
    from app.core.config import settings

    if not settings.FREE_TIER_ENABLED or (org.account_type or "COMPANY") != "INDIVIDUAL":
        return None
    if licences and all(l.status == "REVOKED" for l in licences):
        return None
    # Never automatic: the account chose the Free plan, or it had a trial or paid plan that ended
    if org.free_started_at is None and not licences:
        return None
    admin = db.query(User.id).filter(User.organization_id == org.id, User.role == "ADMIN", User.active == True)
    if settings.EMAIL_VERIFICATION_REQUIRED:
        admin = admin.filter(User.email_verified_at.isnot(None))
    if admin.first() is None:
        return None
    plan = db.query(Plan).filter(Plan.code == FREE_PLAN_CODE, Plan.kind == "FREE", Plan.active == True).first()
    return plan


def _free_entitlement(plan: Plan, licences: list, now: datetime, state: str, pay_with_credits: bool, credits: int,
                      base: dict) -> Entitlement:
    from app.core.config import settings

    # Prepaid credits keep the pay-as-you-go browser allowance
    device_limit = max(plan.device_limit, settings.CREDITS_DEVICE_LIMIT) if credits > 0 else plan.device_limit
    ended = [l for l in licences if l.status == "ACTIVE" and l.expires_at is not None and aware(l.expires_at) <= now]
    last = max(ended, key=lambda l: aware(l.expires_at)) if ended else None
    # No expires_at: the free plan does not end, so device sessions are not capped by a date
    ent = Entitlement(state=state, plan_code=plan.code, kind="FREE", device_limit=device_limit,
                      check_limit=plan.check_limit, pay_with_credits=pay_with_credits,
                      last_expired_at=last.expires_at if last else None, **base)
    if last is not None:
        ent.extra["ended_licence"] = last  # for the "moved to the Free plan" notice
    return ent


def current_entitlement(db: Session, organization_id: str, now: Optional[datetime] = None) -> Entitlement:
    """The account's access right now, decided only from server data (licences, credits, metered usage)."""
    now = now or utcnow()
    org = db.query(Organization).filter(Organization.id == organization_id).first()
    used = active_device_count(db, organization_id)
    if org is None:
        return Entitlement(state="NONE", devices_used=used)
    credits = int(org.credit_balance or 0)
    checks, credit_checks = month_usage(db, organization_id, now)
    base = {"devices_used": used, "credit_balance": credits, "checks_this_month": checks,
            "included_checks_used": checks - credit_checks, "monthly_cap": org.monthly_check_cap}
    if org.suspended_at is not None:
        return Entitlement(state="SUSPENDED", **base)

    licences = db.query(License).filter(License.organization_id == organization_id).all()
    live = [
        l for l in licences
        if l.status == "ACTIVE" and aware(l.starts_at) <= now and (l.expires_at is None or aware(l.expires_at) > now)
    ]
    free = None if live else free_plan_for(db, org, licences)
    # The account's own monthly limit applies to every way of paying (on the free plan it pauses checks)
    if org.monthly_check_cap is not None and checks >= org.monthly_check_cap:
        if free is not None:
            return _free_entitlement(free, licences, now, "FREE_PAUSED", False, credits, base)
        return Entitlement(state="CAP_REACHED", **base)

    if free is not None:
        over = free.check_limit is not None and (checks - credit_checks) >= free.check_limit
        if over and credits <= 0:
            return _free_entitlement(free, licences, now, "FREE_PAUSED", False, credits, base)
        return _free_entitlement(free, licences, now, "FREE_ACTIVE", over, credits, base)

    if live:
        # Prefer a paid/internal licence over a trial, then the one that lasts longest
        def rank(l: License):
            return (0 if l.kind == "TRIAL" else 1, aware(l.expires_at) or datetime.max.replace(tzinfo=timezone.utc))

        best = max(live, key=rank)
        plan = db.query(Plan).filter(Plan.code == best.plan_code).first()
        limit = plan.check_limit if plan is not None and best.kind != "INTERNAL" else None
        over = limit is not None and (checks - credit_checks) >= limit
        state = "TRIAL_ACTIVE" if best.kind == "TRIAL" else "SUBSCRIPTION_ACTIVE"
        if over and credits <= 0:
            state = "LIMIT_REACHED"
        return Entitlement(
            state=state, license=best, plan_code=best.plan_code, kind=best.kind, expires_at=best.expires_at,
            device_limit=best.device_limit, check_limit=limit, pay_with_credits=over and credits > 0, **base,
        )

    # No licence covers "now": prepaid credits (pay as you go) keep the account protected
    if credits > 0:
        from app.core.config import settings

        return Entitlement(state="CREDITS_ACTIVE", plan_code="credits", kind="CREDITS",
                           device_limit=settings.CREDITS_DEVICE_LIMIT, pay_with_credits=True, **base)
    if not licences:
        bought = db.query(CreditLedger.id).filter(CreditLedger.organization_id == organization_id, CreditLedger.delta > 0).first()
        return Entitlement(state="NO_CREDITS" if bought else "NONE", **base)
    if all(l.status == "REVOKED" for l in licences):
        return Entitlement(state="REVOKED", **base)
    ended = [aware(l.expires_at) for l in licences if l.status == "ACTIVE" and l.expires_at is not None]
    latest = max(licences, key=lambda l: aware(l.expires_at) or now)
    return Entitlement(
        state="EXPIRED", license=latest, plan_code=latest.plan_code, kind=latest.kind,
        expires_at=latest.expires_at, last_expired_at=max(ended) if ended else None, **base,
    )


def grant_license(
    db: Session, organization_id: str, plan: Plan, created_by: str, *, starts_at: Optional[datetime] = None,
    payment_ref: Optional[str] = None, device_limit: Optional[int] = None,
) -> License:
    """Creates a licence for a plan. A paid licence bought before the paid time already bought ends
    starts when it ends (renewals bought in advance chain one after another)."""
    start = starts_at or utcnow()
    if plan.kind == "PAID" and starts_at is None:
        current = current_entitlement(db, organization_id, start)
        if current.state == "SUBSCRIPTION_ACTIVE" and current.expires_at is not None:
            paid_ends = [
                aware(l.expires_at) for l in db.query(License).filter(
                    License.organization_id == organization_id, License.kind == "PAID", License.status == "ACTIVE",
                    License.expires_at.isnot(None),
                ).all()
            ]
            start = max([start, aware(current.expires_at)] + [e for e in paid_ends if e > start])
    licence = License(
        organization_id=organization_id, plan_code=plan.code, kind=plan.kind, status="ACTIVE",
        starts_at=start, expires_at=plan_end(plan, start), device_limit=device_limit or plan.device_limit,
        payment_ref=payment_ref, created_by=created_by,
    )
    db.add(licence)
    db.flush()
    return licence
