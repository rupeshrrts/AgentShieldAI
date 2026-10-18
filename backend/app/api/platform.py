"""Internal admin console API (AgentShieldAI staff only), under /internal/api.

Every route declares its permission with require_staff(...) (core/permissions.py); customer and
device tokens are never accepted. Companies, licences (grants, extensions, revocations), suspensions,
accounts, browsers, plans and pricing, extension releases, the platform-wide audit log, metrics and
the reminder job. Every change is written to the audit log with actor_type=staff.

Paid entitlements normally come only from verified payments (api/payments.py). Granting or
extending a PAID or INTERNAL licence by hand is an "exception": it needs `licenses.exception`
(platform owner), a reason, and is recorded as such (payment_ref = exception:<staff>).
"""
import json
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.api.billing import licence_out, plan_out, release_out
from app.core.audit import record_admin_action
from app.core.entitlements import aware, current_entitlement, grant_license, utcnow
from app.core.notifications import run_reminders
from app.core.permissions import require_staff, staff_has
from app.core.usage import add_credits
from app.db.models import (
    AdminAuditLog,
    BillingPayment,
    CreditLedger,
    Device,
    Endpoint,
    SecurityEvent,
    UsageDaily,
    WebhookEvent,
    ExtensionRelease,
    License,
    LicenseAdjustment,
    Organization,
    Plan,
    Referral,
    StaffUser,
    TrialClaim,
    User,
)
from app.db.session import get_db

router = APIRouter(prefix="/internal/api", tags=["Internal console"])


def _iso(dt) -> Optional[str]:
    return aware(dt).isoformat() if dt else None


def _audit(db: Session, staff: StaffUser, action: str, *, org_id: Optional[str], target_type: str, target_id: str,
           summary: str, request: Request, before=None, after=None) -> None:
    record_admin_action(db, organization_id=org_id, actor=f"staff:{staff.email}", action=action, target_type=target_type,
                        target_id=target_id, summary=summary, before=before, after=after, request=request, actor_type="staff")


def _org_or_404(db: Session, org_id: str) -> Organization:
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if not org:
        raise HTTPException(status_code=404, detail="Company not found.")
    return org


def _licence_or_404(db: Session, licence_id: str) -> License:
    licence = db.query(License).filter(License.id == licence_id).first()
    if not licence:
        raise HTTPException(status_code=404, detail="Licence not found.")
    return licence


def _require_exception_right(staff: StaffUser, what: str) -> None:
    if not staff_has(staff.role, "licenses.exception"):
        raise HTTPException(status_code=403, detail={
            "code": "FORBIDDEN",
            "message": f"{what} without a verified payment is an exception reserved for the platform owner (licenses.exception).",
        })


# --- Companies ---

@router.get("/companies")
def list_companies(staff: StaffUser = Depends(require_staff("companies.read")), db: Session = Depends(get_db)):
    now = utcnow()
    users = dict(db.query(User.organization_id, func.count(User.id)).group_by(User.organization_id).all())
    out = []
    for org in db.query(Organization).order_by(Organization.created_at.desc()).all():
        ent = current_entitlement(db, org.id, now)
        admin = db.query(User).filter(User.organization_id == org.id, User.role == "ADMIN").order_by(User.created_at.asc()).first()
        out.append({
            "id": org.id, "name": org.name, "created_at": _iso(org.created_at),
            "suspended_at": _iso(org.suspended_at), "suspended_reason": org.suspended_reason,
            "owner_email": admin.email if admin else None, "users": int(users.get(org.id, 0)),
            "account_type": org.account_type or "COMPANY", "email_verified": bool(admin and admin.email_verified_at),
            "entitlement": ent.as_dict(now),
        })
    return out


@router.get("/companies/{org_id}")
def company_detail(org_id: str, staff: StaffUser = Depends(require_staff("companies.read")), db: Session = Depends(get_db)):
    org = _org_or_404(db, org_id)
    now = utcnow()
    licences = db.query(License).filter(License.organization_id == org_id).order_by(License.created_at.desc()).all()
    adjustments = (
        db.query(LicenseAdjustment).filter(LicenseAdjustment.license_id.in_([l.id for l in licences] or [""]))
        .order_by(LicenseAdjustment.created_at.desc()).all()
    )
    claim = db.query(TrialClaim).filter(TrialClaim.organization_id == org_id).first()
    detail = {
        "id": org.id, "name": org.name, "created_at": _iso(org.created_at), "account_type": org.account_type or "COMPANY",
        "suspended_at": _iso(org.suspended_at), "suspended_reason": org.suspended_reason,
        "entitlement": current_entitlement(db, org_id, now).as_dict(now),
        "licences": [licence_out(l, now) for l in licences],
        "adjustments": [
            {"license_id": a.license_id, "old_expires_at": _iso(a.old_expires_at), "new_expires_at": _iso(a.new_expires_at),
             "reason": a.reason, "by": a.created_by, "at": _iso(a.created_at)} for a in adjustments
        ],
        "trial_claim": {"email_domain": claim.email_domain, "claimed_at": _iso(claim.claimed_at)} if claim else None,
        "users": [
            {"id": u.id, "email": u.email, "role": u.role, "active": bool(u.active), "verified": u.email_verified_at is not None,
             "created_at": _iso(u.created_at)}
            for u in db.query(User).filter(User.organization_id == org_id).order_by(User.created_at.asc()).all()
        ],
        "devices": [],
    }
    # Browser details only for roles that may see devices (least privilege)
    if staff_has(staff.role, "devices.read"):
        detail["devices"] = [
            {"id": d.id, "user_id": d.user_id, "status": d.status, "browser": d.browser, "platform": d.platform,
             "created_at": _iso(d.created_at), "last_seen_at": _iso(d.last_seen_at)}
            for d in db.query(Device).filter(Device.organization_id == org_id).order_by(Device.created_at.desc()).all()
        ]
    return detail


class ReasonBody(BaseModel):
    reason: str = Field(..., min_length=3, max_length=255)


@router.post("/companies/{org_id}/suspend")
def suspend_company(org_id: str, body: ReasonBody, request: Request, staff: StaffUser = Depends(require_staff("companies.suspend")),
                    db: Session = Depends(get_db)):
    org = _org_or_404(db, org_id)
    org.suspended_at = utcnow()
    org.suspended_reason = body.reason
    db.commit()
    _audit(db, staff, "platform.company_suspend", org_id=org.id, target_type="organization", target_id=org.id,
           summary=f"Suspended {org.name}: {body.reason}", request=request)
    return {"ok": True}


@router.post("/companies/{org_id}/unsuspend")
def unsuspend_company(org_id: str, request: Request, staff: StaffUser = Depends(require_staff("companies.suspend")),
                      db: Session = Depends(get_db)):
    org = _org_or_404(db, org_id)
    org.suspended_at = None
    org.suspended_reason = None
    db.commit()
    _audit(db, staff, "platform.company_unsuspend", org_id=org.id, target_type="organization", target_id=org.id,
           summary=f"Lifted suspension of {org.name}", request=request)
    return {"ok": True}


# --- Licences ---

class GrantBody(BaseModel):
    plan_code: str
    reason: str = Field(..., min_length=3, max_length=255)
    device_limit: Optional[int] = Field(default=None, ge=1, le=100000)


@router.post("/companies/{org_id}/licenses", status_code=201)
def grant(org_id: str, body: GrantBody, request: Request, staff: StaffUser = Depends(require_staff("licenses.manage")),
          db: Session = Depends(get_db)):
    """A trial licence needs licenses.manage; a PAID or INTERNAL one is an audited exception (owner only)."""
    org = _org_or_404(db, org_id)
    plan = db.query(Plan).filter(Plan.code == body.plan_code).first()
    if not plan or plan.kind in ("CREDITS", "FREE"):
        raise HTTPException(status_code=400, detail="Unknown plan. Use the credits action for prepaid credits; the free plan needs no licence.")
    exception = plan.kind in ("PAID", "INTERNAL")
    if exception:
        _require_exception_right(staff, f"Granting the {plan.name} plan")
    ref = f"exception:{staff.email}" if exception else f"manual:{staff.email}"
    licence = grant_license(db, org.id, plan, f"staff:{staff.email}", payment_ref=ref, device_limit=body.device_limit)
    db.add(LicenseAdjustment(license_id=licence.id, old_expires_at=None, new_expires_at=licence.expires_at,
                             reason=f"{'Exception' if exception else 'Granted'}: {body.reason}", created_by=f"staff:{staff.email}"))
    db.commit()
    _audit(db, staff, "platform.license_exception" if exception else "platform.license_grant", org_id=org.id,
           target_type="license", target_id=licence.id,
           summary=f"{'Exception: granted' if exception else 'Granted'} {plan.name} to {org.name} without payment: {body.reason}",
           request=request)
    return licence_out(licence)


class ExtendBody(BaseModel):
    reason: str = Field(..., min_length=3, max_length=500)
    add_days: Optional[int] = Field(default=None, ge=1, le=3650)
    new_expires_at: Optional[datetime] = None


@router.post("/licenses/{licence_id}/extend")
def extend(licence_id: str, body: ExtendBody, request: Request, staff: StaffUser = Depends(require_staff("licenses.manage")),
           db: Session = Depends(get_db)):
    """Extends a licence with a reason (never silent). Extending paid time is an owner-only exception."""
    licence = _licence_or_404(db, licence_id)
    if licence.status == "REVOKED" or licence.expires_at is None:
        raise HTTPException(status_code=400, detail="Revoked or non-expiring licences cannot be extended.")
    if licence.kind != "TRIAL":
        _require_exception_right(staff, "Extending a paid licence")
    old = aware(licence.expires_at)
    if body.new_expires_at is not None:
        new = aware(body.new_expires_at)
    elif body.add_days:
        new = max(old, utcnow()) + timedelta(days=body.add_days)
    else:
        raise HTTPException(status_code=400, detail="Give add_days or new_expires_at.")
    if new <= utcnow():
        raise HTTPException(status_code=400, detail="The new end date must be in the future.")
    licence.expires_at = new
    db.add(LicenseAdjustment(license_id=licence.id, old_expires_at=old, new_expires_at=new, reason=body.reason,
                             created_by=f"staff:{staff.email}"))
    db.commit()
    _audit(db, staff, "platform.license_extend", org_id=licence.organization_id, target_type="license", target_id=licence.id,
           summary=f"Extended {licence.plan_code} licence to {new.strftime('%d %b %Y')}: {body.reason}",
           before={"expires_at": old.isoformat()}, after={"expires_at": new.isoformat()}, request=request)
    return licence_out(licence)


@router.post("/licenses/{licence_id}/revoke")
def revoke(licence_id: str, body: ReasonBody, request: Request, staff: StaffUser = Depends(require_staff("licenses.manage")),
           db: Session = Depends(get_db)):
    licence = _licence_or_404(db, licence_id)
    licence.status = "REVOKED"
    licence.revoked_at = utcnow()
    licence.revoked_by = f"staff:{staff.email}"
    licence.revoked_reason = body.reason
    db.commit()
    _audit(db, staff, "platform.license_revoke", org_id=licence.organization_id, target_type="license", target_id=licence.id,
           summary=f"Revoked {licence.plan_code} licence: {body.reason}", request=request)
    return licence_out(licence)


class DeviceLimitBody(BaseModel):
    device_limit: int = Field(..., ge=1, le=100000)


@router.patch("/licenses/{licence_id}")
def set_device_limit(licence_id: str, body: DeviceLimitBody, request: Request,
                     staff: StaffUser = Depends(require_staff("licenses.manage")), db: Session = Depends(get_db)):
    licence = _licence_or_404(db, licence_id)
    old = licence.device_limit
    licence.device_limit = body.device_limit
    db.commit()
    _audit(db, staff, "platform.license_devices", org_id=licence.organization_id, target_type="license", target_id=licence.id,
           summary=f"Browser limit {old} -> {body.device_limit}", request=request)
    return licence_out(licence)


class CreditsBody(BaseModel):
    delta: int = Field(..., ge=-10_000_000, le=10_000_000)
    reason: str = Field(..., min_length=3, max_length=255)


@router.post("/companies/{org_id}/credits")
def adjust_credits(org_id: str, body: CreditsBody, request: Request, staff: StaffUser = Depends(require_staff("licenses.manage")),
                   db: Session = Depends(get_db)):
    """Adds or removes prepaid credits outside a payment. Adding is an owner-only, audited exception."""
    org = _org_or_404(db, org_id)
    if body.delta == 0:
        raise HTTPException(status_code=400, detail="Give a non-zero number of credits.")
    if body.delta > 0:
        _require_exception_right(staff, "Adding credits")
    balance = add_credits(db, org.id, body.delta, "grant" if body.delta > 0 else "adjust", reference=f"staff:{staff.email}",
                          note=body.reason, created_by=f"staff:{staff.email}")
    db.commit()
    _audit(db, staff, "platform.credits_exception" if body.delta > 0 else "platform.credits_adjust", org_id=org.id,
           target_type="organization", target_id=org.id,
           summary=f"{'Added' if body.delta > 0 else 'Removed'} {abs(body.delta):,} credits ({org.name}, balance {balance:,}): {body.reason}",
           request=request)
    return {"credit_balance": balance}


@router.get("/companies/{org_id}/usage")
def company_usage(org_id: str, staff: StaffUser = Depends(require_staff("companies.read")), db: Session = Depends(get_db)):
    """Daily prompt checks for the last 60 days and the credit ledger (aggregates only; no prompt content)."""
    _org_or_404(db, org_id)
    since = (utcnow() - timedelta(days=60)).strftime("%Y-%m-%d")
    rows = (db.query(UsageDaily.day, func.sum(UsageDaily.prompt_checks), func.sum(UsageDaily.credit_checks))
            .filter(UsageDaily.organization_id == org_id, UsageDaily.day >= since).group_by(UsageDaily.day).order_by(UsageDaily.day).all())
    ledger = (db.query(CreditLedger).filter(CreditLedger.organization_id == org_id).order_by(CreditLedger.created_at.desc()).limit(50).all())
    return {
        "days": [{"day": d, "prompt_checks": int(c or 0), "credit_checks": int(cc or 0)} for d, c, cc in rows],
        "ledger": [{"delta": l.delta, "kind": l.kind, "reference": l.reference, "note": l.note, "balance_after": l.balance_after,
                    "created_by": l.created_by, "created_at": _iso(l.created_at)} for l in ledger],
    }


# --- Customer accounts and browsers ---

@router.post("/users/{user_id}/suspend")
def suspend_user(user_id: str, request: Request, staff: StaffUser = Depends(require_staff("users.suspend")),
                 db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Account not found.")
    user.active = False
    user.session_version = (user.session_version or 0) + 1
    db.commit()
    _audit(db, staff, "platform.user_suspend", org_id=user.organization_id, target_type="user", target_id=user.email,
           summary=f"Suspended account {user.email}", request=request)
    return {"ok": True}


@router.post("/users/{user_id}/activate")
def activate_user(user_id: str, request: Request, staff: StaffUser = Depends(require_staff("users.suspend")),
                  db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Account not found.")
    user.active = True
    db.commit()
    _audit(db, staff, "platform.user_activate", org_id=user.organization_id, target_type="user", target_id=user.email,
           summary=f"Re-enabled account {user.email}", request=request)
    return {"ok": True}


@router.get("/devices")
def all_devices(org_id: Optional[str] = None, staff: StaffUser = Depends(require_staff("devices.read")), db: Session = Depends(get_db)):
    q = db.query(Device)
    if org_id:
        q = q.filter(Device.organization_id == org_id)
    emails = dict(db.query(User.id, User.email).all())
    names = dict(db.query(Organization.id, Organization.name).all())
    return [
        {"id": d.id, "organization_id": d.organization_id, "organization": names.get(d.organization_id), "user_email": emails.get(d.user_id),
         "status": d.status, "browser": d.browser, "platform": d.platform, "created_at": _iso(d.created_at), "last_seen_at": _iso(d.last_seen_at)}
        for d in q.order_by(Device.created_at.desc()).limit(1000).all()
    ]


# --- Plans and pricing ---

class PlanUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=80)
    device_limit: Optional[int] = Field(default=None, ge=1, le=100000)
    duration_days: Optional[int] = Field(default=None, ge=1, le=3650)
    duration_months: Optional[int] = Field(default=None, ge=1, le=120)
    price_minor: Optional[int] = Field(default=None, ge=0, le=10_000_000_000)
    currency: Optional[str] = Field(default=None, pattern="^[A-Z]{3}$")
    features: Optional[List[str]] = None
    purchasable: Optional[bool] = None
    active: Optional[bool] = None
    credits: Optional[int] = Field(default=None, ge=1, le=100_000_000)        # CREDITS packs
    check_limit: Optional[int] = Field(default=None, ge=0, le=100_000_000)    # 0 = unlimited


@router.get("/plans")
def plans(staff: StaffUser = Depends(require_staff("plans.read")), db: Session = Depends(get_db)):
    return [plan_out(p) for p in db.query(Plan).order_by(Plan.sort.asc()).all()]


@router.patch("/plans/{code}")
def update_plan(code: str, body: PlanUpdate, request: Request, staff: StaffUser = Depends(require_staff("plans.manage")),
                db: Session = Depends(get_db)):
    plan = db.query(Plan).filter(Plan.code == code).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found.")
    before = plan_out(plan)
    for field in ("name", "device_limit", "duration_days", "duration_months", "price_minor", "currency", "active"):
        value = getattr(body, field)
        if value is not None:
            setattr(plan, field, value)
    if body.features is not None:
        plan.features = json.dumps([f.strip() for f in body.features if f.strip()][:20])
    if body.credits is not None:
        if plan.kind != "CREDITS":
            raise HTTPException(status_code=400, detail="Only credit packs have a number of credits.")
        plan.credits = body.credits
    if body.check_limit is not None:
        if plan.kind not in ("TRIAL", "PAID", "FREE"):
            raise HTTPException(status_code=400, detail="A monthly prompt-check limit applies to free, trial and paid plans only.")
        if plan.kind == "FREE" and not body.check_limit:
            raise HTTPException(status_code=400, detail="The free plan needs a monthly prompt-check limit (at least 1).")
        plan.check_limit = body.check_limit or None
    if body.purchasable is not None:
        if body.purchasable and (plan.kind not in ("PAID", "CREDITS") or not plan.price_minor or (plan.kind == "CREDITS" and not plan.credits)):
            raise HTTPException(status_code=400, detail="Only a paid plan or credit pack with a price can be offered for sale.")
        plan.purchasable = body.purchasable
    plan.updated_by = f"staff:{staff.email}"
    db.commit()
    after = plan_out(plan)
    changed = {k: (before[k], after[k]) for k in before if before[k] != after[k]}
    _audit(db, staff, "platform.plan_update", org_id=None, target_type="plan", target_id=code,
           summary=f"Updated plan {code}: {', '.join(changed) or 'no change'}", before=before, after=after, request=request)
    return after


# --- Extension releases ---

class ReleaseBody(BaseModel):
    version: str = Field(..., pattern=r"^\d+(\.\d+){1,3}$")
    notes: Optional[str] = Field(default=None, max_length=5000)
    sha256: Optional[str] = Field(default=None, pattern="^[a-f0-9]{64}$")
    size_bytes: Optional[int] = None
    min_chrome: Optional[str] = Field(default="110", max_length=10)
    min_edge: Optional[str] = Field(default="110", max_length=10)
    make_current: bool = True


@router.get("/releases")
def releases(staff: StaffUser = Depends(require_staff("releases.read")), db: Session = Depends(get_db)):
    return [release_out(r) for r in db.query(ExtensionRelease).order_by(ExtensionRelease.published_at.desc()).all()]


@router.post("/releases", status_code=201)
def add_release(body: ReleaseBody, request: Request, staff: StaffUser = Depends(require_staff("releases.manage")),
                db: Session = Depends(get_db)):
    rel = db.query(ExtensionRelease).filter(ExtensionRelease.version == body.version).first()
    if rel is None:
        rel = ExtensionRelease(version=body.version, published_by=f"staff:{staff.email}")
        db.add(rel)
    rel.notes, rel.sha256, rel.size_bytes = body.notes, body.sha256, body.size_bytes
    rel.min_chrome, rel.min_edge = body.min_chrome, body.min_edge
    if body.make_current:
        db.query(ExtensionRelease).update({"is_current": False})
        rel.is_current = True
    db.commit()
    _audit(db, staff, "platform.release", org_id=None, target_type="release", target_id=body.version,
           summary=f"Published extension {body.version}", request=request)
    return release_out(rel)


# --- Audit, metrics, jobs ---

@router.get("/audit")
def platform_audit(limit: int = Query(200, ge=1, le=1000), action: Optional[str] = None, actor_type: Optional[str] = None,
                   staff: StaffUser = Depends(require_staff("audit.read")), db: Session = Depends(get_db)):
    q = db.query(AdminAuditLog)
    if action:
        q = q.filter(AdminAuditLog.action.like(f"{action}%"))
    if actor_type:
        q = q.filter(AdminAuditLog.actor_type == actor_type)
    names = dict(db.query(Organization.id, Organization.name).all())
    return [
        {"occurred_at": _iso(a.occurred_at), "organization": names.get(a.organization_id), "actor": a.actor,
         "actor_type": a.actor_type or "customer", "action": a.action, "summary": a.summary, "ip_address": a.ip_address}
        for a in q.order_by(AdminAuditLog.occurred_at.desc()).limit(limit).all()
    ]


@router.get("/metrics")
def metrics(staff: StaffUser = Depends(require_staff("metrics.read")), db: Session = Depends(get_db)):
    now = utcnow()
    counts = {"TRIAL_ACTIVE": 0, "SUBSCRIPTION_ACTIVE": 0, "FREE_ACTIVE": 0, "FREE_PAUSED": 0, "INTERNAL": 0, "EXPIRED": 0, "NONE": 0, "REVOKED": 0, "SUSPENDED": 0}
    devices_used = 0
    device_capacity = 0
    for org in db.query(Organization).all():
        ent = current_entitlement(db, org.id, now)
        # Internal (non-expiring, not sold) licences are not paying customers
        state = "INTERNAL" if ent.active and ent.kind == "INTERNAL" else ent.state
        counts[state] = counts.get(state, 0) + 1
        if ent.active and ent.kind != "INTERNAL":
            devices_used += ent.devices_used
            device_capacity += ent.device_limit
    trials = db.query(TrialClaim).count()
    converted = (
        db.query(func.count(func.distinct(License.organization_id)))
        .filter(License.kind == "PAID", License.organization_id.in_(db.query(TrialClaim.organization_id)))
        .scalar() or 0
    )
    month = now.strftime("%Y-%m-01")
    checks_month = db.query(func.coalesce(func.sum(UsageDaily.prompt_checks), 0), func.coalesce(func.sum(UsageDaily.credit_checks), 0)) \
        .filter(UsageDaily.day >= month).one()
    month_start_dt = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    revenue = {}
    for cur, amount, refunded in (db.query(BillingPayment.currency, func.sum(BillingPayment.amount_minor), func.sum(BillingPayment.refunded_minor))
                                  .filter(BillingPayment.created_at >= month_start_dt).group_by(BillingPayment.currency).all()):
        revenue[cur] = int(amount or 0) - int(refunded or 0)
    return {
        "companies": db.query(Organization).count(),
        "accounts_by_type": {
            "INDIVIDUAL": db.query(Organization).filter(Organization.account_type == "INDIVIDUAL").count(),
            "COMPANY": db.query(Organization).filter(Organization.account_type != "INDIVIDUAL").count(),
        },
        "accounts": db.query(User).count(),
        "by_state": counts,
        "trials_claimed": trials,
        "trial_conversions": int(converted),
        "active_devices": db.query(Device).filter(Device.status == "ACTIVE").count(),
        "licensed_devices_used": devices_used,
        "licensed_device_capacity": device_capacity,
        "prompt_checks_this_month": int(checks_month[0] or 0),
        "credit_checks_this_month": int(checks_month[1] or 0),
        "credits_outstanding": int(db.query(func.coalesce(func.sum(Organization.credit_balance), 0)).scalar() or 0),
        "credits_sold_this_month": int(db.query(func.coalesce(func.sum(CreditLedger.delta), 0)).filter(
            CreditLedger.kind == "purchase", CreditLedger.created_at >= month_start_dt).scalar() or 0),
        "net_revenue_this_month": revenue,
    }


@router.get("/analytics")
def analytics(days: int = Query(30, ge=7, le=180), staff: StaffUser = Depends(require_staff("metrics.read")),
              db: Session = Depends(get_db)):
    """Trends for the console's charts: sign-ups, prompt checks and protection outcomes per UTC day,
    plan mix, browsers, top accounts by prompt checks, referrals. Counts only: no prompt text, no
    sites, no customer email addresses."""
    now = utcnow()
    start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    day_keys = [(start + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days)]

    signups = {d: {"day": d, "individual": 0, "company": 0} for d in day_keys}
    for created, kind in db.query(Organization.created_at, Organization.account_type).filter(Organization.created_at >= start).all():
        key = aware(created).strftime("%Y-%m-%d")
        if key in signups:
            signups[key]["individual" if kind == "INDIVIDUAL" else "company"] += 1

    checks = {d: {"day": d, "prompt_checks": 0, "blocked": 0, "warned": 0, "redacted": 0} for d in day_keys}
    for day, pc, bl, wa, re_ in (db.query(UsageDaily.day, func.sum(UsageDaily.prompt_checks), func.sum(UsageDaily.blocked),
                                          func.sum(UsageDaily.warned), func.sum(UsageDaily.redacted))
                                 .filter(UsageDaily.day >= day_keys[0]).group_by(UsageDaily.day).all()):
        if day in checks:
            checks[day].update(prompt_checks=int(pc or 0), blocked=int(bl or 0), warned=int(wa or 0), redacted=int(re_ or 0))

    # Protection outcomes and what was found, platform-wide (security events, same period)
    actions = dict(db.query(SecurityEvent.action, func.count(SecurityEvent.id))
                   .filter(SecurityEvent.occurred_at >= start).group_by(SecurityEvent.action).all())
    categories = dict(db.query(SecurityEvent.category, func.count(SecurityEvent.id))
                      .filter(SecurityEvent.occurred_at >= start).group_by(SecurityEvent.category).all())

    # Browsers (active activations) by browser family and operating system
    def family(name: Optional[str]) -> str:
        n = (name or "").lower()
        for key, label in (("edge", "Edge"), ("opera", "Opera"), ("brave", "Brave"), ("chrome", "Chrome"), ("chromium", "Chromium")):
            if key in n:
                return label
        return "Other"

    browsers: dict = {}
    platforms: dict = {}
    for b, p in db.query(Device.browser, Device.platform).filter(Device.status == "ACTIVE").all():
        browsers[family(b)] = browsers.get(family(b), 0) + 1
        label = (p or "Unknown").strip() or "Unknown"
        platforms[label] = platforms.get(label, 0) + 1

    # Accounts with the most prompt checks this month (names only for staff who may read accounts)
    month = now.strftime("%Y-%m-01")
    top_rows = (db.query(UsageDaily.organization_id, func.sum(UsageDaily.prompt_checks).label("n"))
                .filter(UsageDaily.day >= month).group_by(UsageDaily.organization_id)
                .order_by(text("n DESC")).limit(8).all())
    names = {}
    if top_rows and staff_has(staff.role, "companies.read"):
        names = dict(db.query(Organization.id, Organization.name).filter(Organization.id.in_([r[0] for r in top_rows])).all())
    top_accounts = [{"name": names.get(oid) or f"Account {i + 1}", "prompt_checks": int(n or 0)}
                    for i, (oid, n) in enumerate(top_rows)]

    users_by_role = dict(db.query(User.role, func.count(User.id)).group_by(User.role).all())
    owners = db.query(User).join(Organization, Organization.id == User.organization_id).filter(
        User.role == "ADMIN", Organization.account_type == "INDIVIDUAL")
    verified = owners.filter(User.email_verified_at.isnot(None)).count()
    referrals = dict(db.query(Referral.status, func.count(Referral.id)).group_by(Referral.status).all())

    return {
        "days": days,
        "signups_daily": [signups[d] for d in day_keys],
        "checks_daily": [checks[d] for d in day_keys],
        "actions": {k or "UNKNOWN": int(v) for k, v in actions.items()},
        "categories": {k or "UNKNOWN": int(v) for k, v in categories.items()},
        "browsers": browsers,
        "platforms": platforms,
        "top_accounts_this_month": top_accounts,
        "users_by_role": {k: int(v) for k, v in users_by_role.items()},
        "individual_owners": {"verified": verified, "unverified": owners.count() - verified},
        "referrals": {k: int(v) for k, v in referrals.items()},
    }


@router.get("/health")
def platform_health(staff: StaffUser = Depends(require_staff("metrics.read")), db: Session = Depends(get_db)):
    """Operational signals from the last 24 hours (counts only; no customer content)."""
    import time as _time

    t0 = _time.perf_counter()
    db.execute(text("SELECT 1"))
    db_ms = round((_time.perf_counter() - t0) * 1000, 1)
    since = utcnow() - timedelta(hours=24)

    def count(action_prefix: str) -> int:
        return db.query(AdminAuditLog).filter(AdminAuditLog.action.like(f"{action_prefix}%"), AdminAuditLog.occurred_at >= since).count()

    # Extension versions reported by heartbeats in the last 7 days
    versions = dict(db.query(Endpoint.extension_version, func.count(Endpoint.id))
                    .filter(Endpoint.last_seen_at >= utcnow() - timedelta(days=7)).group_by(Endpoint.extension_version).all())
    current = db.query(ExtensionRelease).filter(ExtensionRelease.is_current == True).first()
    return {
        "database": {"ok": True, "latency_ms": db_ms},
        "last_24h": {
            "customer_sign_in_failures": count("login.failed"),
            "staff_sign_in_failures": count("staff.login.failed"),
            "activation_failures": count("device.activate_failed"),
            "device_sign_in_refusals": count("device.session_refused"),
            "webhooks_failed": db.query(WebhookEvent).filter(WebhookEvent.status == "failed", WebhookEvent.received_at >= since).count(),
            "webhooks_received": db.query(WebhookEvent).filter(WebhookEvent.received_at >= since).count(),
            "security_events": db.query(SecurityEvent).filter(SecurityEvent.occurred_at >= since).count(),
            "blocked_prompts": db.query(SecurityEvent).filter(SecurityEvent.occurred_at >= since, SecurityEvent.action == "BLOCK").count(),
        },
        "current_release": current.version if current else None,
        "extension_versions": {str(k or "unknown"): int(v) for k, v in versions.items()},
        "server_time": now_iso(),
    }


def now_iso() -> str:
    return utcnow().isoformat()


@router.post("/jobs/run-reminders")
def run_reminders_now(request: Request, staff: StaffUser = Depends(require_staff("jobs.run")), db: Session = Depends(get_db)):
    created = run_reminders(db)
    _audit(db, staff, "platform.reminders_run", org_id=None, target_type="job", target_id="reminders",
           summary=f"Ran reminders: {created} new", request=request)
    return {"created": created}
