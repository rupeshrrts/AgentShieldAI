"""Accounts, invites, activation codes and authorized devices.

Admin (/api/v1/org/...):
- invite people by email, list accounts and pending invites, disable/enable accounts,
- list every authorized browser, approve pending ones, revoke any of them.

Any signed-in account, including employees (/api/v1/me/...):
- generate a single-use activation code for one browser,
- list and revoke their own browsers.
"""
from datetime import datetime, timedelta, timezone
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin, get_signed_in_user, require_company_workspace
from app.api.schemas import (
    AccountOut,
    AccountUpdate,
    ActivationTokenCreated,
    DeviceOut,
    InviteCreate,
    InviteSent,
    InviteOut,
    UsersPage,
)
from app.core import ratelimit
from app.core.audit import record_admin_action
from app.core.config import settings
from app.core.email import EmailNotConfigured, send_email
from app.core.entitlements import DENIAL_CODES, current_entitlement
from app.core.security import (
    ACTIVATION_TOKEN_PREFIX,
    INVITE_TOKEN_PREFIX,
    TOKEN_TYPE_DOWNLOAD,
    create_access_token,
    generate_secret,
    hash_device_key,
)
from app.api.computers import revoke_computer
from app.db.models import ActivationToken, Computer, Device, Organization, User, UserInvite
from app.db.session import get_db

org_router = APIRouter(prefix="/api/v1/org", tags=["Users & Devices"], dependencies=[Depends(require_company_workspace)])
me_router = APIRouter(prefix="/api/v1/me", tags=["My activation"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def dashboard_url(request: Request) -> str:
    if settings.DASHBOARD_URL:
        return settings.DASHBOARD_URL
    if settings.PUBLIC_BASE_URL:
        return settings.PUBLIC_BASE_URL
    return "http://localhost:5173" if not settings.is_production else str(request.base_url).rstrip("/")


def api_base_url(request: Request) -> str:
    return settings.PUBLIC_BASE_URL or str(request.base_url).rstrip("/")


def _device_out(device: Device, email_by_id: dict, pc_names: Optional[dict] = None) -> DeviceOut:
    out = DeviceOut.model_validate(device)
    out.user_email = email_by_id.get(device.user_id)
    if device.computer_id and pc_names is not None:
        out.computer_name = pc_names.get(device.computer_id)
    return out


def _pc_names(db: Session, organization_id: str) -> dict:
    return dict(db.query(Computer.id, Computer.name).filter(Computer.organization_id == organization_id).all())


def _send_invite(db: Session, request: Request, admin: User, email: str, role: str) -> InviteSent:
    org = db.query(Organization).filter(Organization.id == admin.organization_id).first()
    token = generate_secret(INVITE_TOKEN_PREFIX)
    invite = UserInvite(
        organization_id=admin.organization_id,
        email=email,
        role=role,
        token_hash=hash_device_key(token),
        expires_at=_now() + timedelta(hours=settings.INVITE_EXPIRE_HOURS),
        created_by=admin.email,
    )
    # The token goes in the URL fragment (#), which browsers never send to servers or proxies.
    link = f"{dashboard_url(request)}/#invite={token}"
    body = (
        f"{admin.email} invited you to AgentShield for {org.name if org else 'your organization'}.\n\n"
        f"Create your account (the link works once and expires in {settings.INVITE_EXPIRE_HOURS} hours):\n{link}\n\n"
        "After creating your account, sign in and generate an activation code to connect your browser.\n"
        "If you did not expect this email, ignore it."
    )
    try:
        delivery = send_email(email, "You're invited to AgentShield", body)
    except EmailNotConfigured as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))
    except Exception:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="The invite email could not be sent. Check the SMTP settings.")
    db.add(invite)
    db.commit()
    db.refresh(invite)
    out = InviteSent.model_validate({**InviteOut.model_validate(invite).model_dump(), "delivery": delivery})
    return out


# --- Admin: accounts and invites ---

@org_router.get("/users", response_model=UsersPage)
def list_users(admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    users = db.query(User).filter(User.organization_id == admin.organization_id).order_by(User.created_at.asc()).all()
    counts = dict(
        db.query(Device.user_id, func.count(Device.id))
        .filter(Device.organization_id == admin.organization_id, Device.status != "REVOKED")
        .group_by(Device.user_id)
        .all()
    )
    now = _now()
    invites = [
        i for i in db.query(UserInvite)
        .filter(
            UserInvite.organization_id == admin.organization_id,
            UserInvite.accepted_at.is_(None),
            UserInvite.revoked_at.is_(None),
        )
        .order_by(UserInvite.created_at.desc())
        .all()
        if _aware(i.expires_at) > now
    ]
    accounts = []
    for u in users:
        a = AccountOut.model_validate(u)
        a.device_count = int(counts.get(u.id, 0))
        accounts.append(a)
    return UsersPage(users=accounts, pending_invites=[InviteOut.model_validate(i) for i in invites])


@org_router.post("/users/invite", response_model=InviteSent, status_code=status.HTTP_201_CREATED)
def invite_user(payload: InviteCreate, request: Request, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Emails a single-use link to create an account in the admin's organization."""
    ratelimit.hit("invite-admin", admin.id, 50, 60 * 60, "Too many invites in the last hour.")
    email = payload.email.strip().lower()
    if db.query(User).filter(func.lower(User.email) == email).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="An account with this email already exists.")
    # A new invite replaces any earlier pending one for the same email
    for old in db.query(UserInvite).filter(
        UserInvite.organization_id == admin.organization_id,
        func.lower(UserInvite.email) == email,
        UserInvite.accepted_at.is_(None),
        UserInvite.revoked_at.is_(None),
    ):
        old.revoked_at = _now()
    result = _send_invite(db, request, admin, email, payload.role)
    record_admin_action(
        db, organization_id=admin.organization_id, actor=admin.email, action="user.invite",
        target_type="user", target_id=email, summary=f"Invited {email} as {payload.role}", request=request,
    )
    return result


@org_router.delete("/invites/{invite_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_invite(invite_id: str, request: Request, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    invite = db.query(UserInvite).filter(UserInvite.id == invite_id, UserInvite.organization_id == admin.organization_id).first()
    if not invite or invite.accepted_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invite not found.")
    invite.revoked_at = _now()
    db.commit()
    record_admin_action(
        db, organization_id=admin.organization_id, actor=admin.email, action="user.invite_cancel",
        target_type="user", target_id=invite.email, summary=f"Cancelled the invite for {invite.email}", request=request,
    )
    return None


@org_router.patch("/users/{user_id}", response_model=AccountOut)
def update_user(
    user_id: str, payload: AccountUpdate, request: Request,
    admin: User = Depends(get_current_admin), db: Session = Depends(get_db),
):
    """Disable/enable an account or change its role. Disabling locks all of its browsers at their next request."""
    user = db.query(User).filter(User.id == user_id, User.organization_id == admin.organization_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found.")
    if user.id == admin.id and (payload.active is False or (payload.role and payload.role != "ADMIN")):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot disable or demote your own account.")
    changes = []
    if payload.active is not None and payload.active != user.active:
        user.active = payload.active
        changes.append("enabled" if payload.active else "disabled")
    if payload.role and payload.role != user.role:
        changes.append(f"role {user.role} -> {payload.role}")
        user.role = payload.role
    db.commit()
    if changes:
        record_admin_action(
            db, organization_id=admin.organization_id, actor=admin.email, action="user.update",
            target_type="user", target_id=user.email, summary=f"{user.email}: " + ", ".join(changes), request=request,
        )
    out = AccountOut.model_validate(user)
    out.device_count = db.query(Device).filter(Device.user_id == user.id, Device.status != "REVOKED").count()
    return out


# --- Admin: devices ---

@org_router.get("/devices", response_model=List[DeviceOut])
def list_devices(admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    devices = (
        db.query(Device)
        .filter(Device.organization_id == admin.organization_id)
        .order_by(Device.created_at.desc())
        .all()
    )
    emails = dict(db.query(User.id, User.email).filter(User.organization_id == admin.organization_id).all())
    names = _pc_names(db, admin.organization_id)
    return [_device_out(d, emails, names) for d in devices]


def _org_device(db: Session, admin: User, device_id: str) -> Device:
    device = db.query(Device).filter(Device.id == device_id, Device.organization_id == admin.organization_id).first()
    if not device:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found.")
    return device


@org_router.post("/devices/{device_id}/approve", response_model=DeviceOut)
def approve_device(device_id: str, request: Request, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    device = _org_device(db, admin, device_id)
    if device.status != "PENDING":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only pending devices can be approved.")
    device.status = "ACTIVE"
    device.approved_by = admin.email
    db.commit()
    owner = db.query(User).filter(User.id == device.user_id).first()
    record_admin_action(
        db, organization_id=admin.organization_id, actor=admin.email, action="device.approve",
        target_type="device", target_id=device.id, summary=f"Approved a browser for {owner.email if owner else device.user_id}",
        request=request,
    )
    return _device_out(device, {device.user_id: owner.email if owner else None})


def _revoke(db: Session, device: Device, actor: str) -> None:
    """Signs out a browser. A browser connected through the AgentShield Windows app would reconnect
    through its PC at once, so its whole PC is removed instead (all its browsers sign out)."""
    if device.computer_id:
        computer = db.query(Computer).filter(Computer.id == device.computer_id).first()
        if computer is not None and computer.status != "REVOKED":
            revoke_computer(db, computer, actor)
            return
    device.status = "REVOKED"
    device.revoked_at = _now()
    device.revoked_by = actor
    db.commit()


@org_router.post("/devices/{device_id}/revoke", response_model=DeviceOut)
def revoke_device(device_id: str, request: Request, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Revokes a browser. Its current session stops working on its next request."""
    device = _org_device(db, admin, device_id)
    if device.status != "REVOKED":
        _revoke(db, device, admin.email)
    owner = db.query(User).filter(User.id == device.user_id).first()
    record_admin_action(
        db, organization_id=admin.organization_id, actor=admin.email, action="device.revoke",
        target_type="device", target_id=device.id, summary=f"Revoked a browser of {owner.email if owner else device.user_id}",
        request=request,
    )
    return _device_out(device, {device.user_id: owner.email if owner else None})


# --- Any signed-in account: own activation codes and devices ---

DOWNLOAD_LINK_MINUTES = 5


class DownloadLinkRequest(BaseModel):
    file: Literal["agentshield-extension.zip"]


@me_router.post("/download-link")
def create_download_link(body: DownloadLinkRequest, request: Request, user: User = Depends(get_signed_in_user),
                         db: Session = Depends(get_db)):
    """A short-lived link to download the extension. Only accounts that may connect a
    browser get one: an active trial, plan, credits or the Free plan (the same rule as activation codes)."""
    ratelimit.hit("download-link", user.id, 30, 60 * 60, "Too many downloads in the last hour. Try again later.")
    ent = current_entitlement(db, user.organization_id)
    if not ent.allowed:
        code, message = DENIAL_CODES.get(ent.state, DENIAL_CODES["NONE"])
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"code": code, "message": message})
    token = create_access_token(
        subject=user.id, expires_delta=timedelta(minutes=DOWNLOAD_LINK_MINUTES),
        extra_claims={"typ": TOKEN_TYPE_DOWNLOAD, "file": body.file, "org": user.organization_id},
    )
    return {"url": f"{api_base_url(request)}/extension-updates/download/{body.file}?t={token}",
            "expires_in": DOWNLOAD_LINK_MINUTES * 60}


@me_router.post("/activation-tokens", response_model=ActivationTokenCreated, status_code=status.HTTP_201_CREATED)
def create_activation_token(request: Request, user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)):
    """Single-use code to activate one browser for this account. Shown once; earlier unused codes are revoked."""
    ratelimit.hit("activation-token", user.id, 5, 60 * 60, "You generated several codes in the last hour. Try again later.")
    ent = current_entitlement(db, user.organization_id)
    if not ent.allowed:
        code, message = DENIAL_CODES.get(ent.state, DENIAL_CODES["NONE"])
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"code": code, "message": message})
    now = _now()
    for old in db.query(ActivationToken).filter(
        ActivationToken.user_id == user.id, ActivationToken.used_at.is_(None), ActivationToken.revoked_at.is_(None)
    ):
        old.revoked_at = now
    token = generate_secret(ACTIVATION_TOKEN_PREFIX)
    expires_at = now + timedelta(minutes=settings.ACTIVATION_TOKEN_EXPIRE_MINUTES)
    row = ActivationToken(
        organization_id=user.organization_id,
        user_id=user.id,
        token_hash=hash_device_key(token),
        token_prefix=token[:10],
        expires_at=expires_at,
    )
    db.add(row)
    db.commit()
    record_admin_action(
        db, organization_id=user.organization_id, actor=user.email, action="activation_token.create",
        target_type="activation_token", target_id=row.token_prefix, summary="Generated a browser activation code", request=request,
    )
    # Return the timezone-aware value (SQLite reads datetimes back without a timezone)
    return ActivationTokenCreated(token=token, token_prefix=row.token_prefix, expires_at=expires_at, api_url=api_base_url(request))


@me_router.get("/devices", response_model=List[DeviceOut])
def my_devices(user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)):
    devices = db.query(Device).filter(Device.user_id == user.id).order_by(Device.created_at.desc()).all()
    names = _pc_names(db, user.organization_id)
    return [_device_out(d, {user.id: user.email}, names) for d in devices]


@me_router.post("/devices/{device_id}/revoke", response_model=DeviceOut)
def revoke_my_device(device_id: str, request: Request, user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)):
    device = db.query(Device).filter(Device.id == device_id, Device.user_id == user.id).first()
    if not device:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found.")
    if device.status != "REVOKED":
        _revoke(db, device, user.email)
        record_admin_action(
            db, organization_id=user.organization_id, actor=user.email, action="device.revoke",
            target_type="device", target_id=device.id, summary="Revoked one of own browsers", request=request,
        )
    return _device_out(device, {user.id: user.email})
