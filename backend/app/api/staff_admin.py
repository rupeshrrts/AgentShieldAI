"""Internal staff management (platform owner only): invite, change role, disable, reset MFA, end sessions.

The last active platform owner can never be demoted or disabled, so the platform always has one.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core import ratelimit
from app.core.audit import record_admin_action
from app.core.config import settings
from app.core.email import EmailNotConfigured, send_email
from app.core.permissions import OWNER, STAFF_ROLE_LABELS, STAFF_ROLES, require_staff
from app.core.security import generate_secret, hash_device_key
from app.db.models import StaffInvite, StaffRecoveryCode, StaffUser
from app.db.session import get_db

STAFF_INVITE_PREFIX = "ast_"
STAFF_INVITE_HOURS = 48

router = APIRouter(prefix="/internal/api/staff", tags=["Internal console: staff"])
manage = require_staff("staff.manage")


def _iso(dt) -> Optional[str]:
    if dt is None:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).isoformat()


def console_url(request: Request) -> str:
    if settings.ADMIN_CONSOLE_URL:
        return settings.ADMIN_CONSOLE_URL
    return "http://localhost:5175" if not settings.is_production else str(request.base_url).rstrip("/")


def _out(db: Session, s: StaffUser) -> dict:
    pending = db.query(StaffInvite).filter(StaffInvite.staff_id == s.id, StaffInvite.accepted_at.is_(None),
                                           StaffInvite.revoked_at.is_(None)).first()
    return {
        "id": s.id, "email": s.email, "name": s.name, "role": s.role, "role_label": STAFF_ROLE_LABELS.get(s.role, s.role),
        "active": bool(s.active), "mfa_enabled": s.totp_enabled_at is not None, "must_change_password": bool(s.must_change_password),
        "invite_pending": pending is not None and s.password_hash is None, "last_login_at": _iso(s.last_login_at),
        "created_at": _iso(s.created_at), "created_by": s.created_by,
    }


def _audit(db, actor: StaffUser, action: str, target: StaffUser, summary: str, request: Request) -> None:
    record_admin_action(db, organization_id=None, actor=f"staff:{actor.email}", action=action, target_type="staff",
                        target_id=target.email, summary=summary, request=request, actor_type="staff")


def _active_owners(db: Session) -> int:
    return db.query(StaffUser).filter(StaffUser.role == OWNER, StaffUser.active == True).count()


@router.get("")
def list_staff(staff: StaffUser = Depends(manage), db: Session = Depends(get_db)):
    return {"roles": [{"role": r, "label": STAFF_ROLE_LABELS[r]} for r in STAFF_ROLES],
            "staff": [_out(db, s) for s in db.query(StaffUser).order_by(StaffUser.created_at.asc()).all()]}


class InviteBody(BaseModel):
    email: str = Field(..., max_length=255)
    name: Optional[str] = Field(default=None, max_length=120)
    role: str


@router.post("/invite", status_code=status.HTTP_201_CREATED)
def invite_staff(body: InviteBody, request: Request, owner: StaffUser = Depends(manage), db: Session = Depends(get_db)):
    ratelimit.hit("staff-invite", owner.id, 30, 60 * 60, "Too many invites in the last hour.")
    email = body.email.strip().lower()
    if body.role not in STAFF_ROLES:
        raise HTTPException(status_code=400, detail="Unknown role.")
    if "@" not in email:
        raise HTTPException(status_code=400, detail="Enter a valid email.")
    if db.query(StaffUser).filter(func.lower(StaffUser.email) == email).first():
        raise HTTPException(status_code=409, detail="A staff account with this email already exists.")
    staff = StaffUser(email=email, name=(body.name or "").strip() or None, role=body.role, active=True,
                      created_by=owner.email)
    db.add(staff)
    db.flush()
    token = generate_secret(STAFF_INVITE_PREFIX)
    db.add(StaffInvite(staff_id=staff.id, token_hash=hash_device_key(token), created_by=owner.email,
                       expires_at=datetime.now(timezone.utc) + timedelta(hours=STAFF_INVITE_HOURS)))
    link = f"{console_url(request)}/#staff-invite={token}"
    body_text = (
        f"{owner.email} invited you to the AgentShieldAI internal console as {STAFF_ROLE_LABELS[body.role]}.\n\n"
        f"Set your password (the link works once and expires in {STAFF_INVITE_HOURS} hours):\n{link}\n\n"
        "You will then set up an authenticator app (required)."
    )
    try:
        delivery = send_email(email, "Your AgentShieldAI internal console invite", body_text)
    except EmailNotConfigured as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception:
        db.rollback()
        raise HTTPException(status_code=502, detail="The invite email could not be sent. Check the SMTP settings.")
    db.commit()
    _audit(db, owner, "staff.invited", staff, f"Invited {email} as {STAFF_ROLE_LABELS[body.role]}", request)
    return {**_out(db, staff), "delivery": delivery}


class UpdateBody(BaseModel):
    role: Optional[str] = None
    active: Optional[bool] = None


@router.patch("/{staff_id}")
def update_staff(staff_id: str, body: UpdateBody, request: Request, owner: StaffUser = Depends(manage), db: Session = Depends(get_db)):
    target = db.query(StaffUser).filter(StaffUser.id == staff_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="Staff member not found.")
    losing_owner = target.role == OWNER and target.active and (
        (body.role is not None and body.role != OWNER) or body.active is False)
    if losing_owner and _active_owners(db) <= 1:
        raise HTTPException(status_code=400, detail="The platform must keep at least one active platform owner.")
    changes = []
    if body.role is not None and body.role != target.role:
        if body.role not in STAFF_ROLES:
            raise HTTPException(status_code=400, detail="Unknown role.")
        changes.append(f"role {target.role} -> {body.role}")
        target.role = body.role
        target.session_version = (target.session_version or 0) + 1  # new permissions take effect at once
    if body.active is not None and body.active != target.active:
        changes.append("enabled" if body.active else "disabled")
        target.active = body.active
        target.session_version = (target.session_version or 0) + 1
    db.commit()
    if changes:
        _audit(db, owner, "staff.updated", target, f"{target.email}: {', '.join(changes)}", request)
    return _out(db, target)


@router.post("/{staff_id}/reset-mfa")
def reset_mfa(staff_id: str, request: Request, owner: StaffUser = Depends(manage), db: Session = Depends(get_db)):
    """For a lost phone: the person must enrol a new authenticator at next sign-in."""
    target = db.query(StaffUser).filter(StaffUser.id == staff_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="Staff member not found.")
    if target.id == owner.id:
        raise HTTPException(status_code=400, detail="Use another owner account to reset your own authenticator.")
    target.totp_secret_enc = None
    target.totp_enabled_at = None
    target.totp_last_step = None
    target.session_version = (target.session_version or 0) + 1
    db.query(StaffRecoveryCode).filter(StaffRecoveryCode.staff_id == target.id).delete()
    db.commit()
    _audit(db, owner, "staff.mfa_reset", target, f"Reset the authenticator of {target.email}", request)
    return _out(db, target)


@router.post("/{staff_id}/end-sessions")
def end_sessions(staff_id: str, request: Request, owner: StaffUser = Depends(manage), db: Session = Depends(get_db)):
    target = db.query(StaffUser).filter(StaffUser.id == staff_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="Staff member not found.")
    target.session_version = (target.session_version or 0) + 1
    db.commit()
    _audit(db, owner, "staff.sessions_ended", target, f"Ended all sessions of {target.email}", request)
    return _out(db, target)
