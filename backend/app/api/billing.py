"""Customer billing and licence endpoints (Phase 1: free trial, status, plans, notices).

- GET  /api/v1/billing/status    any signed-in account: the company's entitlement, licences,
                                  trial eligibility, browsers used and notices
- GET  /api/v1/billing/plans     plans the portal shows (prices are set by the platform admin)
- POST /api/v1/billing/trial     company admin: claim the free trial (once; abuse checks below)
- POST /api/v1/billing/free      individual account owner: choose the Free plan (never automatic)
- POST /api/v1/billing/notifications/{id}/read
- GET  /api/v1/releases/current  public: current extension release (download page)

Payments (Razorpay) arrive in Phase 2; nothing here can create a paid licence.
"""
import json
from datetime import timedelta
from typing import Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin, get_signed_in_user
from app.core import abuse, ratelimit
from app.core.audit import record_admin_action
from app.core.config import settings
from app.core.entitlements import aware, current_entitlement, grant_license, utcnow
from app.db.models import ExtensionRelease, License, Notification, Organization, Plan, TrialClaim, User
from app.db.session import get_db

router = APIRouter(prefix="/api/v1/billing", tags=["Billing & licences"])
releases_router = APIRouter(prefix="/api/v1/releases", tags=["Extension releases"])


def plan_out(p: Plan) -> dict:
    try:
        features = json.loads(p.features or "[]")
    except ValueError:
        features = []
    return {
        "code": p.code, "name": p.name, "kind": p.kind, "duration_days": p.duration_days,
        "duration_months": p.duration_months, "device_limit": p.device_limit, "price_minor": p.price_minor,
        "currency": p.currency, "billing": p.billing, "features": features, "purchasable": bool(p.purchasable),
        "active": bool(p.active), "sort": p.sort, "credits": p.credits, "check_limit": p.check_limit,
    }


def licence_out(l: License, now=None) -> dict:
    now = now or utcnow()
    expired = l.expires_at is not None and aware(l.expires_at) <= now
    return {
        "id": l.id, "plan_code": l.plan_code, "kind": l.kind,
        "status": "REVOKED" if l.status == "REVOKED" else ("EXPIRED" if expired else ("SCHEDULED" if aware(l.starts_at) > now else "ACTIVE")),
        "starts_at": aware(l.starts_at).isoformat() if l.starts_at else None,
        "expires_at": aware(l.expires_at).isoformat() if l.expires_at else None,
        "device_limit": l.device_limit, "payment_ref": l.payment_ref, "revoked_reason": l.revoked_reason,
        "created_at": aware(l.created_at).isoformat() if l.created_at else None,
    }


def trial_eligibility(db: Session, user: User, ip: Optional[str]) -> Tuple[bool, str]:
    """Server-side trial rules. Returns (eligible, reason when not eligible)."""
    org_id = user.organization_id
    org = db.query(Organization).filter(Organization.id == org_id).first()
    individual = org is not None and org.account_type == "INDIVIDUAL"
    if db.query(TrialClaim).filter(TrialClaim.organization_id == org_id).first() or db.query(License).filter(License.organization_id == org_id).first():
        return False, "This account has already used its free trial or has a plan."
    if settings.EMAIL_VERIFICATION_REQUIRED and user.email_verified_at is None:
        return False, "Confirm your email address to start your free trial. Check your inbox, or send a new link."
    domain = abuse.email_domain(user.email)
    if abuse.is_disposable_domain(domain):
        return False, "Free trials are not available for temporary email addresses."
    if db.query(TrialClaim).filter(TrialClaim.email_normalized == abuse.normalize_email(user.email)).first():
        return False, "This email address has already been used for a free trial."
    # One trial per company domain applies to company workspaces; individuals are limited per person
    if not individual and not abuse.is_public_domain(domain) and db.query(TrialClaim).filter(TrialClaim.email_domain == domain).first():
        return False, f"A free trial was already claimed for {domain}. Ask your colleague to invite you, or contact sales."
    if ip:
        since = utcnow() - timedelta(days=30)
        recent = db.query(TrialClaim).filter(TrialClaim.ip_hash == abuse.hash_ip(ip), TrialClaim.claimed_at >= since).count()
        if recent >= settings.TRIAL_CLAIMS_PER_IP_30D:
            return False, "Too many free trials have been claimed from this network. Contact support."
    return True, ""


def free_eligibility(db: Session, user: User) -> Tuple[bool, str]:
    """May this account choose the Free plan now? (Individual accounts, confirmed email, not already on it.)"""
    org = db.query(Organization).filter(Organization.id == user.organization_id).first()
    if not settings.FREE_TIER_ENABLED or not db.query(Plan).filter(Plan.code == "free", Plan.kind == "FREE", Plan.active == True).first():
        return False, "The Free plan is not available right now."
    if org is None or (org.account_type or "COMPANY") != "INDIVIDUAL":
        return False, "The Free plan is for individual accounts."
    if org.free_started_at is not None:
        return False, "You already chose the Free plan."
    if user.role != "ADMIN":
        return False, "Only the account owner can choose a plan."
    if settings.EMAIL_VERIFICATION_REQUIRED and user.email_verified_at is None:
        return False, "Confirm your email address to start the Free plan. Check your inbox, or send a new link."
    return True, ""


@router.get("/status")
def billing_status(request: Request, user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)):
    now = utcnow()
    ent = current_entitlement(db, user.organization_id, now)
    eligible, reason = trial_eligibility(db, user, ratelimit.client_key(request))
    free_ok, free_reason = free_eligibility(db, user)
    org = db.query(Organization).filter(Organization.id == user.organization_id).first()
    licences = (
        db.query(License).filter(License.organization_id == user.organization_id).order_by(License.created_at.desc()).all()
    )
    notes = (
        db.query(Notification).filter(Notification.organization_id == user.organization_id)
        .order_by(Notification.created_at.desc()).limit(20).all()
    )
    return {
        "server_time": now.isoformat(),
        "entitlement": ent.as_dict(now),
        "trial": {"eligible": eligible and user.role == "ADMIN", "reason": reason or (
            "" if user.role == "ADMIN" else "Only your company's administrator can claim the trial."
        ), "days": settings.TRIAL_DAYS},
        "free": {"eligible": free_ok, "reason": free_reason,
                 "started_at": aware(org.free_started_at).isoformat() if org and org.free_started_at else None},
        "licences": [licence_out(l, now) for l in licences],
        "notifications": [
            {"id": n.id, "kind": n.kind, "title": n.title, "body": n.body, "read": n.read_at is not None,
             "created_at": aware(n.created_at).isoformat() if n.created_at else None}
            for n in notes
        ],
    }


@router.get("/plans")
def list_plans(user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)):
    plans = db.query(Plan).filter(Plan.active == True, Plan.kind != "INTERNAL").order_by(Plan.sort.asc()).all()
    return [plan_out(p) for p in plans]


@router.post("/trial", status_code=status.HTTP_201_CREATED)
def claim_trial(request: Request, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Starts the company's free trial (server time, once). Refused with a reason when not eligible."""
    ip = ratelimit.client_key(request)
    ratelimit.hit("trial-claim-ip", ip, 10, 60 * 60, "Too many attempts. Try again later.")
    eligible, reason = trial_eligibility(db, admin, ip)
    if not eligible:
        record_admin_action(
            db, organization_id=admin.organization_id, actor=admin.email, action="trial.refused",
            target_type="license", target_id=admin.organization_id, summary=f"Trial refused: {reason}", request=request,
        )
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "TRIAL_NOT_ELIGIBLE", "message": reason})
    plan = db.query(Plan).filter(Plan.code == "trial", Plan.active == True).first()
    if not plan:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="The free trial is not available right now.")
    try:
        licence = grant_license(db, admin.organization_id, plan, admin.email)
        db.add(TrialClaim(
            organization_id=admin.organization_id, user_id=admin.id,
            email_normalized=abuse.normalize_email(admin.email), email_domain=abuse.email_domain(admin.email),
            ip_hash=abuse.hash_ip(ip) if ip else None, license_id=licence.id,
        ))
        db.commit()
    except IntegrityError:
        # A concurrent claim for the same company or email won the race
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "TRIAL_NOT_ELIGIBLE", "message": "The free trial was already claimed."})
    record_admin_action(
        db, organization_id=admin.organization_id, actor=admin.email, action="trial.claimed",
        target_type="license", target_id=licence.id,
        summary=f"Claimed the free trial (ends {aware(licence.expires_at).strftime('%d %b %Y')})", request=request,
    )
    return licence_out(licence)


@router.post("/free", status_code=status.HTTP_201_CREATED)
def start_free_plan(request: Request, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Chooses the Free plan (individual accounts with a confirmed email). Access, downloads and activation
    codes start only after an account chooses a plan."""
    ok, reason = free_eligibility(db, admin)
    if not ok:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "FREE_NOT_ELIGIBLE", "message": reason})
    org = db.query(Organization).filter(Organization.id == admin.organization_id).first()
    org.free_started_at = utcnow()
    db.commit()
    record_admin_action(db, organization_id=org.id, actor=admin.email, action="plan.free_started", target_type="organization",
                        target_id=org.id, summary="Chose the Free plan", request=request)
    return current_entitlement(db, org.id).as_dict()


@router.post("/notifications/{note_id}/read", status_code=status.HTTP_204_NO_CONTENT)
def mark_read(note_id: str, user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)):
    note = db.query(Notification).filter(Notification.id == note_id, Notification.organization_id == user.organization_id).first()
    if note and note.read_at is None:
        note.read_at = utcnow()
        db.commit()
    return None


def release_out(r: ExtensionRelease) -> dict:
    return {
        "version": r.version, "notes": r.notes, "sha256": r.sha256, "size_bytes": r.size_bytes,
        "min_chrome": r.min_chrome, "min_edge": r.min_edge, "is_current": bool(r.is_current),
        "published_at": aware(r.published_at).isoformat() if r.published_at else None,
    }


@releases_router.get("/current")
def current_release(db: Session = Depends(get_db)):
    """Public: the current extension release shown on the download page (no licence needed to download)."""
    rel = db.query(ExtensionRelease).filter(ExtensionRelease.is_current == True).first()
    if not rel:
        rel = db.query(ExtensionRelease).order_by(ExtensionRelease.published_at.desc()).first()
    return release_out(rel) if rel else None
