"""Internal console sign-in for AgentShieldAI staff (separate from customer accounts).

1. POST /internal/auth/login: email + password. Never returns a session, only a short-lived
   step token: `mfa_setup` (authenticator not enrolled yet, 10 min) or `mfa` (5 min).
2. Enrolment: POST /mfa/setup (secret + otpauth URI), POST /mfa/enable {code}: returns the
   recovery codes once and the session.
3. POST /mfa/verify {code | recovery_code}: the session (typ=staff, STAFF_TOKEN_HOURS, carries sv).
A temporary password (bootstrap) must be changed before any other internal API works.
Every step is rate-limited and audited (actor_type=staff).
"""
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Deque, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core import ratelimit, totp
from app.core.audit import record_admin_action
from app.core.config import settings
from app.core.permissions import (
    STAFF_ROLE_LABELS,
    TOKEN_TYPE_STAFF,
    TOKEN_TYPE_STAFF_MFA,
    TOKEN_TYPE_STAFF_MFA_SETUP,
    get_staff_session,
    staff_from_token,
    staff_permissions,
)
from app.core.security import create_access_token, hash_device_key, hash_password, verify_password
from app.db.models import StaffInvite, StaffRecoveryCode, StaffUser
from app.db.session import get_db

router = APIRouter(prefix="/internal/auth", tags=["Internal console: sign-in"])
_bearer = HTTPBearer(auto_error=False)

MIN_STAFF_PASSWORD = 14
_MAX_FAILED = 5
_LOCK_SECONDS = 15 * 60
_failed: Dict[str, Deque[float]] = defaultdict(deque)


def _audit(db: Session, staff_email: str, action: str, summary: str, request: Optional[Request] = None) -> None:
    record_admin_action(db, organization_id=None, actor=f"staff:{staff_email}", action=action, target_type="staff",
                        target_id=staff_email, summary=summary, request=request, actor_type="staff")


def _recent_failures(key: str) -> Deque[float]:
    window = _failed[key]
    now = time.monotonic()
    while window and now - window[0] > _LOCK_SECONDS:
        window.popleft()
    return window


def _step_token(staff: StaffUser, typ: str, minutes: int) -> str:
    return create_access_token(subject=staff.id, expires_delta=timedelta(minutes=minutes),
                               extra_claims={"typ": typ, "sv": staff.session_version or 0})


def staff_out(staff: StaffUser) -> dict:
    return {
        "id": staff.id, "email": staff.email, "name": staff.name, "role": staff.role,
        "role_label": STAFF_ROLE_LABELS.get(staff.role, staff.role), "permissions": staff_permissions(staff.role),
        "must_change_password": bool(staff.must_change_password), "mfa_enabled": staff.totp_enabled_at is not None,
    }


def issue_staff_session(db: Session, staff: StaffUser) -> dict:
    staff.last_login_at = datetime.now(timezone.utc)
    db.commit()
    token = create_access_token(subject=staff.id, expires_delta=timedelta(hours=settings.STAFF_TOKEN_HOURS),
                                extra_claims={"typ": TOKEN_TYPE_STAFF, "sv": staff.session_version or 0, "role": staff.role})
    return {"access_token": token, "token_type": "bearer", "expires_in": settings.STAFF_TOKEN_HOURS * 3600, "staff": staff_out(staff)}


def _check_new_password(password: str) -> None:
    if len(password) < MIN_STAFF_PASSWORD:
        raise HTTPException(status_code=400, detail=f"Use at least {MIN_STAFF_PASSWORD} characters.")
    if len(set(password)) < 6:
        raise HTTPException(status_code=400, detail="Choose a less repetitive password.")


def _step_staff(credentials: Optional[HTTPAuthorizationCredentials], db: Session, typ: str) -> StaffUser:
    staff = staff_from_token(credentials.credentials if credentials else None, db, expected_type=typ)
    if staff is None:
        raise HTTPException(status_code=401, detail="This sign-in step expired. Start again.")
    if typ == TOKEN_TYPE_STAFF_MFA_SETUP and staff.totp_enabled_at is not None:
        # An enrolment token must never replace an authenticator that is already set up
        raise HTTPException(status_code=409, detail="An authenticator is already set up. Sign in again.")
    return staff


# --- Password step ---------------------------------------------------------------------------

class StaffLogin(BaseModel):
    email: str = Field(..., max_length=255)
    password: str = Field(..., max_length=256)


@router.post("/login")
def staff_login(body: StaffLogin, request: Request, db: Session = Depends(get_db)):
    ip = ratelimit.client_key(request)
    ratelimit.hit("staff-login-ip", ip, 30, 15 * 60, "Too many sign-in attempts from this network. Try again later.")
    email = body.email.strip().lower()
    failures = _recent_failures(email)
    if len(failures) >= _MAX_FAILED:
        _audit(db, email, "staff.login.locked", "Internal sign-in refused: temporarily locked", request)
        raise HTTPException(status_code=429, detail="Too many failed attempts. Try again in 15 minutes.")
    staff = db.query(StaffUser).filter(func.lower(StaffUser.email) == email).first()
    if not staff or not staff.active or not staff.password_hash or not verify_password(body.password, staff.password_hash):
        failures.append(time.monotonic())
        _audit(db, email, "staff.login.failed", "Failed internal sign-in (wrong email or password)", request)
        raise HTTPException(status_code=401, detail="Invalid email or password.")
    failures.clear()
    if staff.totp_enabled_at is None:
        return {"step": "mfa_setup", "token": _step_token(staff, TOKEN_TYPE_STAFF_MFA_SETUP, 10),
                "must_change_password": bool(staff.must_change_password)}
    return {"step": "mfa", "token": _step_token(staff, TOKEN_TYPE_STAFF_MFA, 5),
            "must_change_password": bool(staff.must_change_password)}


# --- Authenticator enrolment -----------------------------------------------------------------

@router.post("/mfa/setup")
def mfa_setup(credentials: Optional[HTTPAuthorizationCredentials] = Security(_bearer), db: Session = Depends(get_db)):
    """New authenticator secret (replaces any unfinished one). Shown once; stored encrypted."""
    staff = _step_staff(credentials, db, TOKEN_TYPE_STAFF_MFA_SETUP)
    secret = totp.new_secret()
    staff.totp_secret_enc = totp.encrypt_secret(secret)
    db.commit()
    return {"secret": secret, "otpauth_uri": totp.provisioning_uri(secret, staff.email), "issuer": totp.ISSUER}


class CodeBody(BaseModel):
    code: Optional[str] = Field(default=None, max_length=12)
    recovery_code: Optional[str] = Field(default=None, max_length=32)


def _recovery_hash(staff: StaffUser, code: str) -> str:
    # Codes are random (~59 bits), so a fast keyed digest is enough; the staff id binds it to one account
    return hash_device_key(f"{staff.id}:{totp.normalize_recovery_code(code)}")


def _new_recovery_codes(db: Session, staff: StaffUser) -> list:
    db.query(StaffRecoveryCode).filter(StaffRecoveryCode.staff_id == staff.id).delete()
    codes = totp.new_recovery_codes()
    for c in codes:
        db.add(StaffRecoveryCode(staff_id=staff.id, code_hash=_recovery_hash(staff, c)))
    return codes


@router.post("/mfa/enable")
def mfa_enable(body: CodeBody, request: Request, credentials: Optional[HTTPAuthorizationCredentials] = Security(_bearer),
               db: Session = Depends(get_db)):
    staff = _step_staff(credentials, db, TOKEN_TYPE_STAFF_MFA_SETUP)
    ratelimit.hit("staff-mfa", staff.id, 10, 5 * 60, "Too many attempts. Wait a few minutes.")
    secret = totp.decrypt_secret(staff.totp_secret_enc or "")
    step = totp.verify(secret, body.code or "", None) if secret else None
    if step is None:
        _audit(db, staff.email, "staff.mfa.failed", "Wrong authenticator code during enrolment", request)
        raise HTTPException(status_code=400, detail="That code is not valid. Check the time on your phone and try again.")
    staff.totp_enabled_at = datetime.now(timezone.utc)
    staff.totp_last_step = step
    codes = _new_recovery_codes(db, staff)
    db.commit()
    _audit(db, staff.email, "staff.mfa.enrolled", "Enrolled an authenticator app", request)
    _audit(db, staff.email, "staff.login.success", "Signed in to the internal console", request)
    return {"recovery_codes": codes, "session": issue_staff_session(db, staff)}


# --- Code step -------------------------------------------------------------------------------

@router.post("/mfa/verify")
def mfa_verify(body: CodeBody, request: Request, credentials: Optional[HTTPAuthorizationCredentials] = Security(_bearer),
               db: Session = Depends(get_db)):
    staff = _step_staff(credentials, db, TOKEN_TYPE_STAFF_MFA)
    ratelimit.hit("staff-mfa", staff.id, 10, 5 * 60, "Too many attempts. Wait a few minutes.")
    if body.recovery_code:
        row = db.query(StaffRecoveryCode).filter(
            StaffRecoveryCode.staff_id == staff.id, StaffRecoveryCode.used_at.is_(None),
            StaffRecoveryCode.code_hash == _recovery_hash(staff, body.recovery_code),
        ).first()
        if row is not None:
            row.used_at = datetime.now(timezone.utc)
            db.commit()
            left = db.query(StaffRecoveryCode).filter(StaffRecoveryCode.staff_id == staff.id, StaffRecoveryCode.used_at.is_(None)).count()
            _audit(db, staff.email, "staff.recovery_code_used", f"Signed in with a recovery code ({left} left)", request)
            return issue_staff_session(db, staff)
        _audit(db, staff.email, "staff.mfa.failed", "Wrong recovery code", request)
        raise HTTPException(status_code=400, detail="That recovery code is not valid or was already used.")
    secret = totp.decrypt_secret(staff.totp_secret_enc or "")
    step = totp.verify(secret, body.code or "", staff.totp_last_step) if secret else None
    if step is None:
        _audit(db, staff.email, "staff.mfa.failed", "Wrong or reused authenticator code", request)
        raise HTTPException(status_code=400, detail="That code is not valid (each code works once).")
    staff.totp_last_step = step
    db.commit()
    _audit(db, staff.email, "staff.login.success", "Signed in to the internal console", request)
    return issue_staff_session(db, staff)


# --- Session ---------------------------------------------------------------------------------

@router.get("/me")
def staff_me(staff: StaffUser = Depends(get_staff_session)):
    return staff_out(staff)


class ChangePassword(BaseModel):
    current_password: str = Field(..., max_length=256)
    new_password: str = Field(..., max_length=256)


@router.post("/change-password")
def staff_change_password(body: ChangePassword, request: Request, staff: StaffUser = Depends(get_staff_session),
                          db: Session = Depends(get_db)):
    if not verify_password(body.current_password, staff.password_hash or ""):
        raise HTTPException(status_code=400, detail="Current password is incorrect.")
    if body.new_password == body.current_password:
        raise HTTPException(status_code=400, detail="Choose a new password.")
    _check_new_password(body.new_password)
    staff.password_hash = hash_password(body.new_password)
    staff.must_change_password = False
    staff.session_version = (staff.session_version or 0) + 1
    db.commit()
    _audit(db, staff.email, "staff.password_changed", "Changed own password (other sessions ended)", request)
    return issue_staff_session(db, staff)


@router.post("/logout-all", status_code=status.HTTP_204_NO_CONTENT)
def staff_logout_all(request: Request, staff: StaffUser = Depends(get_staff_session), db: Session = Depends(get_db)):
    staff.session_version = (staff.session_version or 0) + 1
    db.commit()
    _audit(db, staff.email, "staff.logout_all", "Signed out everywhere", request)
    return None


# --- Invites ---------------------------------------------------------------------------------

def _open_invite(db: Session, token: str) -> StaffInvite:
    invite = db.query(StaffInvite).filter(StaffInvite.token_hash == hash_device_key((token or "").strip())).first()
    now = datetime.now(timezone.utc)
    expires = invite.expires_at if invite else None
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if not invite or invite.accepted_at or invite.revoked_at or expires < now:
        raise HTTPException(status_code=404, detail="This invite link is invalid, expired or already used.")
    return invite


@router.get("/invite/{token}")
def staff_invite_info(token: str, request: Request, db: Session = Depends(get_db)):
    ratelimit.hit("staff-invite-ip", ratelimit.client_key(request), 30, 15 * 60)
    invite = _open_invite(db, token)
    staff = db.query(StaffUser).filter(StaffUser.id == invite.staff_id).first()
    return {"email": staff.email, "role": staff.role, "role_label": STAFF_ROLE_LABELS.get(staff.role, staff.role)}


class AcceptInvite(BaseModel):
    token: str = Field(..., max_length=200)
    password: str = Field(..., max_length=256)


@router.post("/accept-invite")
def staff_accept_invite(body: AcceptInvite, request: Request, db: Session = Depends(get_db)):
    """Sets the password; the next step is mandatory authenticator enrolment."""
    ratelimit.hit("staff-invite-ip", ratelimit.client_key(request), 30, 15 * 60)
    invite = _open_invite(db, body.token)
    _check_new_password(body.password)
    staff = db.query(StaffUser).filter(StaffUser.id == invite.staff_id, StaffUser.active == True).first()
    if not staff:
        raise HTTPException(status_code=404, detail="This invite is no longer valid.")
    staff.password_hash = hash_password(body.password)
    staff.must_change_password = False
    invite.accepted_at = datetime.now(timezone.utc)
    db.commit()
    _audit(db, staff.email, "staff.invite_accepted", "Accepted a staff invite and set a password", request)
    return {"step": "mfa_setup", "token": _step_token(staff, TOKEN_TYPE_STAFF_MFA_SETUP, 10), "must_change_password": False}
