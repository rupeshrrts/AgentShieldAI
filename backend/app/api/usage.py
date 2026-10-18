"""Usage and credits for the signed-in account (personal dashboard).

  GET   /api/v1/usage               this month, daily series, plan limits, credit balance (own account only)
  PATCH /api/v1/usage/settings      own monthly limit on prompt checks (admin of the account)
  GET   /api/v1/usage/credits       credit ledger (purchases, refunds, grants)

Numbers come only from server records (usage_daily, credit_ledger, licences); nothing the browser
sends is trusted. Metering itself happens in api/events.py via core/usage.py.
"""
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin, get_signed_in_user
from app.core.audit import record_admin_action
from app.core.entitlements import aware, current_entitlement, utcnow
from app.db.models import CreditLedger, Organization, UsageDaily, User
from app.db.session import get_db

router = APIRouter(prefix="/api/v1/usage", tags=["Usage & credits"])


@router.get("")
def my_usage(days: int = Query(30, ge=1, le=365), user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)):
    now = utcnow()
    since = (now - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    q = db.query(UsageDaily).filter(UsageDaily.organization_id == user.organization_id, UsageDaily.day >= since)
    if user.role == "EMPLOYEE":  # in a company workspace an employee sees only their own usage
        q = q.filter(UsageDaily.user_email == user.email)
    by_day = {}
    for r in q.all():
        d = by_day.setdefault(r.day, {"day": r.day, "prompt_checks": 0, "credit_checks": 0, "blocked": 0, "warned": 0, "redacted": 0})
        for k in ("prompt_checks", "credit_checks", "blocked", "warned", "redacted"):
            d[k] += int(getattr(r, k) or 0)
    series = []
    for i in range(days):
        day = (now - timedelta(days=days - 1 - i)).strftime("%Y-%m-%d")
        series.append(by_day.get(day, {"day": day, "prompt_checks": 0, "credit_checks": 0, "blocked": 0, "warned": 0, "redacted": 0}))
    ent = current_entitlement(db, user.organization_id, now)
    return {
        "period_days": days,
        "month_start": now.strftime("%Y-%m-01"),
        "entitlement": ent.as_dict(now),
        "totals": {k: sum(d[k] for d in series) for k in ("prompt_checks", "credit_checks", "blocked", "warned", "redacted")},
        "daily": series,
        "unit": "prompt check",
    }


class UsageSettings(BaseModel):
    # None or 0 removes the limit
    monthly_check_cap: Optional[int] = Field(default=None, ge=0, le=100_000_000)


@router.patch("/settings")
def update_usage_settings(body: UsageSettings, request: Request, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    org = db.query(Organization).filter(Organization.id == admin.organization_id).first()
    old = org.monthly_check_cap
    org.monthly_check_cap = body.monthly_check_cap or None
    db.commit()
    record_admin_action(db, organization_id=org.id, actor=admin.email, action="usage.cap_update", target_type="organization",
                        target_id=org.id, summary=f"Monthly prompt-check limit {old or 'none'} -> {org.monthly_check_cap or 'none'}",
                        request=request)
    return current_entitlement(db, org.id).as_dict()


@router.get("/credits")
def my_credit_ledger(user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)):
    org = db.query(Organization).filter(Organization.id == user.organization_id).first()
    rows = (db.query(CreditLedger).filter(CreditLedger.organization_id == user.organization_id)
            .order_by(CreditLedger.created_at.desc()).limit(100).all())
    used_total = db.query(func.coalesce(func.sum(UsageDaily.credit_checks), 0)).filter(
        UsageDaily.organization_id == user.organization_id).scalar()
    return {
        "balance": int(org.credit_balance or 0),
        "used_total": int(used_total or 0),
        "entries": [
            {"delta": r.delta, "kind": r.kind, "note": r.note, "balance_after": r.balance_after,
             "created_at": aware(r.created_at).isoformat() if r.created_at else None}
            for r in rows
        ],
    }
