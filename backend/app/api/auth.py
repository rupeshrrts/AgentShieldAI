"""Authentication API Endpoints.

- Sign-up: email + password only; creates a new company (organization) named after the email,
  with its own rules, and its first account as that company's ADMIN, and signs it in at once.
  There is no email-confirmation step (email_verified_at is set later by a password reset link;
  /verify-email only serves links sent by older versions).
- Sign-in: returns a signed JWT (HS256) carrying role, tenant and session version ("sv").
  Password change/reset and "sign out everywhere" bump the session version, so older
  tokens stop working.
- Password reset: single-use emailed link; the same answer whether or not the email exists.
- Invites: an admin adds people to their company (api/users.py); /accept-invite creates them.
Repeated failed sign-ins for an account are temporarily locked out.
"""

import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Deque, Dict, Optional

from pydantic import BaseModel, Field

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_signed_in_user
from app.api.schemas import (
    AcceptInviteRequest,
    ChangePasswordRequest,
    EmailRequest,
    InviteInfo,
    LoginRequest,
    MeResponse,
    ResetPasswordRequest,
    SignUpRequest,
    TokenResponse,
    VerifyEmailRequest,
)
from app.api.users import dashboard_url
from app.core import abuse, ratelimit
from app.core.audit import record_admin_action
from app.core.config import settings
from app.core.email import EmailNotConfigured, send_email
from app.core.referrals import record_signup_referral, reward_on_confirmation
from app.core.security import (
    VERIFY_TOKEN_PREFIX,
    create_access_token,
    generate_secret,
    hash_device_key,
    hash_password,
    verify_password,
)
from app.db.models import EmailVerification, Organization, User, UserInvite
from app.db.seed import provision_organization
from app.db.session import get_db

router = APIRouter(prefix="/auth", tags=["Authentication"])

# DENY-LIST, not credentials: passwords published by older releases (README / SQL seed). They are
# refused as new passwords, and accounts still using one are flagged in the dashboard.
_KNOWN_DEFAULT_PASSWORDS = ("AdminShield2026!", "Auditor2026!")

_MAX_FAILED_ATTEMPTS = 5
_LOCKOUT_SECONDS = 15 * 60
_failed_logins: Dict[str, Deque[float]] = defaultdict(deque)

RESET_TOKEN_PREFIX = "asr_"


def _recent_failures(email: str) -> Deque[float]:
    window = _failed_logins[email]
    now = time.monotonic()
    while window and now - window[0] > _LOCKOUT_SECONDS:
        window.popleft()
    return window


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def issue_session(db: Session, user: User) -> TokenResponse:
    """Signed dashboard JWT with role, tenant and session version."""
    org = db.query(Organization).filter(Organization.id == user.organization_id).first()
    token = create_access_token(
        subject=user.id,
        expires_delta=timedelta(hours=settings.DASHBOARD_TOKEN_HOURS),
        extra_claims={"email": user.email, "role": user.role, "org_id": user.organization_id, "sv": user.session_version or 0},
    )
    return TokenResponse(
        access_token=token,
        token_type="bearer",
        user_id=user.id,
        email=user.email,
        role=user.role,
        organization_id=user.organization_id,
        organization_name=org.name if org else "",
        account_type=(org.account_type if org else None) or "COMPANY",
        email_verified=user.email_verified_at is not None,
        email_verification_required=settings.EMAIL_VERIFICATION_REQUIRED,
        display_name=user.display_name,
    )


def _end_all_sessions(user: User) -> None:
    user.session_version = (user.session_version or 0) + 1


def _check_password_choice(password: str) -> None:
    if password in _KNOWN_DEFAULT_PASSWORDS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That password is publicly documented. Choose another.")


# --- Sign-in, sign-out, password ---

@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)):
    """Checks the email and password and issues a signed JWT."""
    email_key = payload.email.strip().lower()
    ip = ratelimit.client_key(request)
    ratelimit.check("login-fail-ip", ip, 30, 15 * 60, "Too many failed sign-in attempts from this network. Try again later.")
    user = db.query(User).filter(func.lower(User.email) == email_key).first()
    org_id = user.organization_id if user else None

    failures = _recent_failures(email_key)
    if len(failures) >= _MAX_FAILED_ATTEMPTS:
        record_admin_action(
            db, organization_id=org_id, actor=email_key, action="login.locked",
            target_type="user", target_id=email_key, summary="Sign-in refused: account temporarily locked", request=request,
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed sign-in attempts. Try again in 15 minutes.",
        )

    if not user or not verify_password(payload.password, user.password_hash):
        failures.append(time.monotonic())
        ratelimit.record("login-fail-ip", ip)
        record_admin_action(
            db, organization_id=org_id, actor=email_key, action="login.failed",
            target_type="user", target_id=email_key, summary="Failed sign-in (wrong email or password)", request=request,
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not user.active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account has been disabled. Please contact your administrator.",
        )
    failures.clear()
    record_admin_action(
        db, organization_id=user.organization_id, actor=user.email, action="login.success",
        target_type="user", target_id=user.email, summary="Signed in to the dashboard", request=request,
    )
    return issue_session(db, user)


@router.post("/logout-all", status_code=status.HTTP_204_NO_CONTENT)
def logout_everywhere(request: Request, current_user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)):
    """Ends every dashboard session of this account (all browsers and devices)."""
    _end_all_sessions(current_user)
    db.commit()
    record_admin_action(
        db, organization_id=current_user.organization_id, actor=current_user.email, action="user.logout_all",
        target_type="user", target_id=current_user.email, summary="Signed out everywhere", request=request,
    )
    return None


@router.post("/change-password", response_model=TokenResponse)
def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    current_user: User = Depends(get_signed_in_user),
    db: Session = Depends(get_db),
):
    """Changes the password (minimum 12 characters), ends other sessions and returns a fresh one."""
    if not verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect.")
    if payload.new_password == payload.current_password:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="New password must be different.")
    _check_password_choice(payload.new_password)
    current_user.password_hash = hash_password(payload.new_password)
    _end_all_sessions(current_user)
    db.commit()
    record_admin_action(
        db, organization_id=current_user.organization_id, actor=current_user.email, action="user.password_change",
        target_type="user", target_id=current_user.email, summary="Changed own password", request=request,
    )
    return issue_session(db, current_user)


def _new_link(db: Session, user: User, purpose: str, prefix: str, lifetime: timedelta) -> str:
    """Single-use emailed link token; older unused links of the same purpose stop working."""
    now = datetime.now(timezone.utc)
    for old in db.query(EmailVerification).filter(
        EmailVerification.user_id == user.id, EmailVerification.purpose == purpose, EmailVerification.used_at.is_(None)
    ):
        old.used_at = now
    token = generate_secret(prefix)
    db.add(EmailVerification(user_id=user.id, purpose=purpose, token_hash=hash_device_key(token), expires_at=now + lifetime))
    return token


def _open_link(db: Session, token: str, purpose: str) -> EmailVerification:
    row = db.query(EmailVerification).filter(EmailVerification.token_hash == hash_device_key((token or "").strip())).first()
    if not row or row.purpose != purpose or row.used_at is not None or _aware(row.expires_at) < datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This link is invalid, expired or already used. Request a new one.")
    return row


@router.post("/forgot-password", status_code=status.HTTP_202_ACCEPTED)
def forgot_password(payload: EmailRequest, request: Request, db: Session = Depends(get_db)):
    """Emails a password-reset link. Same answer whether or not the account exists."""
    ratelimit.hit("reset-ip", ratelimit.client_key(request), 10, 60 * 60, "Too many requests. Try again later.")
    email = payload.email.strip().lower()
    ratelimit.hit("reset-email", email, 3, 60 * 60, "Too many requests. Try again later.")
    user = db.query(User).filter(func.lower(User.email) == email).first()
    if user and user.active:
        token = _new_link(db, user, "reset", RESET_TOKEN_PREFIX, timedelta(minutes=settings.PASSWORD_RESET_EXPIRE_MINUTES))
        body = (
            "Someone asked to reset the password of your AgentShield account.\n\n"
            f"Set a new password (the link works once and expires in {settings.PASSWORD_RESET_EXPIRE_MINUTES} minutes):\n"
            f"{dashboard_url(request)}/#reset={token}\n\n"
            "If this wasn't you, ignore this email; your password stays the same."
        )
        try:
            send_email(user.email, "Reset your AgentShield password", body)
            db.commit()
            record_admin_action(
                db, organization_id=user.organization_id, actor=user.email, action="user.password_reset_requested",
                target_type="user", target_id=user.email, summary="Requested a password reset link", request=request,
            )
        except Exception:
            db.rollback()
    return {"status": "check_email", "message": "If an account exists for this email, a reset link is on its way."}


@router.post("/reset-password", response_model=TokenResponse)
def reset_password(payload: ResetPasswordRequest, request: Request, db: Session = Depends(get_db)):
    """Sets a new password from a reset link, ends every other session and signs in."""
    ratelimit.hit("reset-use-ip", ratelimit.client_key(request), 30, 15 * 60)
    row = _open_link(db, payload.token, "reset")
    user = db.query(User).filter(User.id == row.user_id, User.active == True).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This account is disabled.")
    _check_password_choice(payload.password)
    row.used_at = datetime.now(timezone.utc)
    user.email_verified_at = user.email_verified_at or row.used_at  # opening the emailed link proves the inbox
    user.password_hash = hash_password(payload.password)
    _end_all_sessions(user)
    _failed_logins.pop(user.email.lower(), None)
    db.commit()
    record_admin_action(
        db, organization_id=user.organization_id, actor=user.email, action="user.password_reset",
        target_type="user", target_id=user.email, summary="Reset password with an emailed link", request=request,
    )
    return issue_session(db, user)


# --- Invites ---

def _open_invite(db: Session, token: str) -> UserInvite:
    """The pending, unexpired invite for a link token, or 404 (same answer for every failure)."""
    invite = db.query(UserInvite).filter(UserInvite.token_hash == hash_device_key(token.strip())).first() if token else None
    if (
        not invite
        or invite.accepted_at is not None
        or invite.revoked_at is not None
        or _aware(invite.expires_at) < datetime.now(timezone.utc)
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This invite link is invalid, expired or already used. Ask your administrator for a new one.",
        )
    return invite


@router.get("/invite/{token}", response_model=InviteInfo)
def invite_info(token: str, request: Request, db: Session = Depends(get_db)):
    """Shows which email and organization an invite link is for (before setting a password)."""
    ratelimit.hit("invite-ip", ratelimit.client_key(request), 30, 15 * 60)
    invite = _open_invite(db, token)
    org = db.query(Organization).filter(Organization.id == invite.organization_id).first()
    return InviteInfo(email=invite.email, organization_name=org.name if org else "", role=invite.role, expires_at=invite.expires_at)


@router.post("/accept-invite", response_model=TokenResponse)
def accept_invite(payload: AcceptInviteRequest, request: Request, db: Session = Depends(get_db)):
    """Creates the account from an emailed invite. Opening the link proves the email address."""
    ratelimit.hit("invite-ip", ratelimit.client_key(request), 30, 15 * 60)
    invite = _open_invite(db, payload.token)
    _check_password_choice(payload.password)
    if db.query(User).filter(func.lower(User.email) == invite.email.lower()).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="An account with this email already exists. Sign in instead.")

    now = datetime.now(timezone.utc)
    user = User(
        organization_id=invite.organization_id,
        email=invite.email.lower(),
        password_hash=hash_password(payload.password),
        role=invite.role,
        active=True,
        email_verified_at=now,
    )
    db.add(user)
    invite.accepted_at = now
    db.commit()
    db.refresh(user)
    record_admin_action(
        db, organization_id=user.organization_id, actor=user.email, action="user.invite_accepted",
        target_type="user", target_id=user.email, summary="Accepted invite and created account", request=request,
    )
    return issue_session(db, user)


# --- Self sign-up (signs in straight away; no email confirmation step) ---

def _default_company_name(email: str) -> str:
    local, _, domain = email.partition("@")
    if abuse.is_public_domain(domain):
        return f"{local}'s workspace"
    return domain.split(".")[0].replace("-", " ").title()


def _send_verification(db: Session, request: Request, user: User) -> str:
    """Emails a single-use confirmation link (token in the URL fragment); returns 'smtp' or 'log'."""
    token = _new_link(db, user, "verify", VERIFY_TOKEN_PREFIX, timedelta(hours=settings.EMAIL_VERIFY_EXPIRE_HOURS))
    link = f"{dashboard_url(request)}/#verify={token}"
    body = (
        "Confirm your email to finish creating your AgentShield account.\n\n"
        f"Open this link (it works once and expires in {settings.EMAIL_VERIFY_EXPIRE_HOURS} hours):\n{link}\n\n"
        f"Confirming unlocks the Free plan and your free {settings.TRIAL_DAYS}-day trial (or choose a plan). Then download the extension, "
        "generate an activation code and paste it into the extension.\n"
        "If you did not create an account, ignore this email."
    )
    delivery = send_email(user.email, "Confirm your AgentShield account", body)
    db.commit()
    return delivery


@router.get("/signup-info")
def signup_info():
    """What the sign-up page offers: individual accounts now; company workspaces when enabled ("coming soon")."""
    return {
        "enabled": settings.SIGNUP_ENABLED, "allowed_domains": settings.SIGNUP_ALLOWED_DOMAINS, "trial_days": settings.TRIAL_DAYS,
        "individual_enabled": settings.SIGNUP_ENABLED, "company_enabled": settings.SIGNUP_ENABLED and settings.COMPANY_SIGNUP_ENABLED,
        # False on a local test server without SMTP: links are printed in the server's terminal instead
        "email_delivery": settings.email_configured,
        # False (default): no "confirm your email" step before the Free plan and the trial
        "email_verification_required": settings.EMAIL_VERIFICATION_REQUIRED,
    }


@router.post("/signup", status_code=status.HTTP_201_CREATED, response_model=TokenResponse)
def signup(payload: SignUpRequest, request: Request, db: Session = Depends(get_db)):
    """Creates an account and signs it in.

    INDIVIDUAL (public): a one-person account. COMPANY: refused unless COMPANY_SIGNUP_ENABLED ("coming soon").
    A confirmation link is emailed; the free trial starts only after the email is confirmed.
    An already registered email gets 409 (sign-in or password reset is the way back in).
    """
    if not settings.SIGNUP_ENABLED:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Self sign-up is turned off. Ask your administrator for an invite.")
    if payload.account_type == "COMPANY" and not settings.COMPANY_SIGNUP_ENABLED:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={
            "code": "COMPANY_COMING_SOON", "message": "Company accounts are coming soon. Create an individual account for now."})
    ratelimit.hit("signup-ip", ratelimit.client_key(request), 10, 60 * 60, "Too many sign-ups from this network. Try again later.")
    email = payload.email.strip().lower()
    domain = abuse.email_domain(email)
    if settings.SIGNUP_ALLOWED_DOMAINS and domain not in settings.SIGNUP_ALLOWED_DOMAINS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Use your work email address to create an account.")
    if abuse.is_disposable_domain(domain):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Temporary email addresses can't be used. Use your work email.")
    # Only real addresses: a valid format and a domain that can receive email (typos like gmail.comrre refused)
    if settings.SIGNUP_CHECK_EMAIL_DOMAIN:
        problem = abuse.email_address_problem(email)
        if problem:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"code": "EMAIL_INVALID", "message": problem})
    _check_password_choice(payload.password)

    if db.query(User).filter(func.lower(User.email) == email).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this email already exists. Sign in, or use Forgot password.",
        )

    display_name = (payload.name or "").strip()[:120] or None
    if payload.account_type == "COMPANY":
        workspace = (payload.company_name or "").strip() or _default_company_name(email)
    else:
        workspace = display_name or email.split("@")[0]
    org = Organization(name=workspace[:100], retention_days=30, account_type=payload.account_type)
    db.add(org)
    db.flush()
    provision_organization(db, org)
    user = User(organization_id=org.id, email=email, password_hash=hash_password(payload.password), role="ADMIN",
                active=True, display_name=display_name)
    db.add(user)
    # Invite link: rewarded only once this person confirms their email (core/referrals.py)
    record_signup_referral(db, payload.referral_code, org, email)
    try:
        db.commit()
    except IntegrityError:  # the same email signing up twice at once
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="An account with this email already exists. Sign in instead.")
    db.refresh(user)
    record_admin_action(
        db, organization_id=org.id, actor=email, action="user.signup",
        target_type="user", target_id=email, summary=f"Created {payload.account_type.lower()} account '{org.name}'",
        request=request,
    )
    if settings.EMAIL_VERIFICATION_REQUIRED:
        try:
            _send_verification(db, request, user)  # the free plan and trial need a confirmed email; sign-in does not
        except Exception:
            db.rollback()  # the user can send a new link from the dashboard
    return issue_session(db, user)


@router.post("/resend-verification", status_code=status.HTTP_202_ACCEPTED)
def resend_verification(payload: EmailRequest, request: Request, db: Session = Depends(get_db)):
    ratelimit.hit("verify-resend-ip", ratelimit.client_key(request), 10, 60 * 60, "Too many requests. Try again later.")
    email = payload.email.strip().lower()
    ratelimit.hit("verify-resend-email", email, 3, 60 * 60, "Too many requests. Try again later.")
    user = db.query(User).filter(func.lower(User.email) == email).first()
    if user and user.active and user.email_verified_at is None:
        try:
            _send_verification(db, request, user)
        except Exception:
            pass  # same answer either way
    return {"status": "check_email", "message": "If this account is waiting for confirmation, a new link is on its way."}


@router.post("/verify-email", response_model=TokenResponse)
def verify_email(payload: VerifyEmailRequest, request: Request, db: Session = Depends(get_db)):
    """Confirms the email from the link and signs the user in."""
    ratelimit.hit("verify-ip", ratelimit.client_key(request), 30, 15 * 60)
    row = _open_link(db, payload.token, "verify")
    user = db.query(User).filter(User.id == row.user_id, User.active == True).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This account is disabled.")
    now = datetime.now(timezone.utc)
    row.used_at = now
    first_confirmation = user.email_verified_at is None
    if first_confirmation:
        user.email_verified_at = now
    db.commit()
    record_admin_action(
        db, organization_id=user.organization_id, actor=user.email, action="user.email_verified",
        target_type="user", target_id=user.email, summary="Confirmed email address", request=request,
    )
    if first_confirmation:
        try:
            if reward_on_confirmation(db, user):
                record_admin_action(
                    db, organization_id=user.organization_id, actor="system", action="referral.rewarded",
                    target_type="user", target_id=user.email,
                    summary=f"Referral bonus: {settings.REFERRAL_BONUS_CHECKS} prompt checks to both accounts", request=request,
                )
        except Exception:
            db.rollback()  # a failed bonus never blocks the confirmation
    return issue_session(db, user)


@router.get("/me", response_model=MeResponse)
def me(current_user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)):
    """The signed-in account, including whether it still uses a publicly documented default password."""
    org = db.query(Organization).filter(Organization.id == current_user.organization_id).first()
    return MeResponse(
        user_id=current_user.id,
        email=current_user.email,
        role=current_user.role,
        organization_id=current_user.organization_id,
        organization_name=org.name if org else "",
        using_default_password=any(verify_password(p, current_user.password_hash) for p in _KNOWN_DEFAULT_PASSWORDS),
        email_verified=current_user.email_verified_at is not None,
        email_verification_required=settings.EMAIL_VERIFICATION_REQUIRED,
        account_type=(org.account_type if org else None) or "COMPANY",
        display_name=current_user.display_name,
    )


class ProfileUpdate(BaseModel):
    display_name: Optional[str] = Field(default=None, max_length=120)


@router.patch("/me", response_model=MeResponse)
def update_profile(body: ProfileUpdate, request: Request, current_user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)):
    """Own profile. For an individual account the workspace name follows the person's name."""
    name = (body.display_name or "").strip() or None
    current_user.display_name = name
    org = db.query(Organization).filter(Organization.id == current_user.organization_id).first()
    if org is not None and org.account_type == "INDIVIDUAL" and name:
        org.name = name[:100]
    db.commit()
    record_admin_action(db, organization_id=current_user.organization_id, actor=current_user.email, action="user.profile_update",
                        target_type="user", target_id=current_user.email, summary="Updated own profile", request=request)
    return me(current_user, db)
