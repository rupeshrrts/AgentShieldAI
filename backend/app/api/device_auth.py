"""Browser activation and device sessions.

1. POST /activate   The extension sends the single-use activation code the user generated
                    while signed in to the dashboard (it identifies that account), plus the
                    public half of a key pair the browser just created. The account must be
                    verified and active and the code unused, unexpired and not revoked; the
                    code is then consumed and the browser becomes an authorized Device bound
                    to that account (or PENDING admin approval).
2. POST /challenge  The browser asks for a one-time nonce (valid 60 s).
3. POST /session    It signs the nonce with its private key (which cannot be exported from
                    the browser). The server checks the signature against the stored public
                    key and issues a short-lived session token (DEVICE_SESSION_MINUTES).

Every extension API call then re-checks the device, account and organization
(api/deps.py), so revoking a device or disabling an account takes effect immediately.

Errors carry a machine-readable code in detail.code: INVALID_TOKEN,
EXPIRED, REVOKED, ACCOUNT_DISABLED, DEVICE_LIMIT, INVALID_DEVICE_KEY, PENDING_APPROVAL,
DEVICE_UNKNOWN, INVALID_SIGNATURE, and for the company's licence (core/entitlements.py)
NO_LICENSE, LICENSE_EXPIRED, LICENSE_REVOKED, ORG_SUSPENDED. A session never outlives the licence.
"""
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Dict

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import Principal, get_principal
from app.api.schemas import (
    DeviceActivateRequest,
    DeviceActivateResponse,
    DeviceChallengeRequest,
    DeviceChallengeResponse,
    DeviceSessionRequest,
    DeviceSessionResponse,
)
from app.api.organization import get_org_settings
from app.core import ratelimit
from app.core.audit import record_admin_action
from app.core.config import settings
from app.core.entitlements import DENIAL_CODES, aware, current_entitlement, user_slot_count, utcnow
from app.core.security import (
    TOKEN_TYPE_CHALLENGE,
    TOKEN_TYPE_DEVICE,
    create_access_token,
    decode_access_token,
    hash_device_key,
    is_valid_device_public_key,
    verify_device_signature,
)
from app.db.models import ActivationToken, Computer, Device, Organization, User
from app.db.session import get_db

router = APIRouter(prefix="/api/v1/device", tags=["Device activation"])

CHALLENGE_SECONDS = 60

# Nonces already exchanged for a session (per process), so a captured signature cannot be replayed.
_used_nonces: Dict[str, float] = {}


def _fail(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _org_name(db: Session, organization_id: str) -> str:
    org = db.query(Organization).filter(Organization.id == organization_id).first()
    return org.name if org else ""


@router.post("/activate", response_model=DeviceActivateResponse, status_code=status.HTTP_201_CREATED)
def activate(payload: DeviceActivateRequest, request: Request, db: Session = Depends(get_db)):
    ip = ratelimit.client_key(request)
    ratelimit.hit("activate-ip", ip, 10, 60 * 60, "Too many activation attempts from this network. Try again later.")

    # 1. Activation code: it identifies the account that generated it while signed in to the
    #    dashboard. Unknown codes are refused without revealing anything.
    raw = payload.activation_token.strip()
    token = db.query(ActivationToken).filter(ActivationToken.token_hash == hash_device_key(raw)).first()
    if not token:
        record_admin_action(
            db, organization_id=None, actor=f"ip:{ip}", action="device.activate_failed",
            target_type="device", target_id=raw[:10], summary="Browser activation refused: unknown activation code",
            request=request,
        )
        raise _fail(status.HTTP_400_BAD_REQUEST, "INVALID_TOKEN", "This activation code is not valid. Generate a new one in your dashboard.")
    user = db.query(User).filter(User.id == token.user_id).first()
    actor = user.email if user else token.user_id

    def audit_failure(org_id, reason: str):
        record_admin_action(
            db, organization_id=org_id, actor=actor, action="device.activate_failed",
            target_type="device", target_id=token.token_prefix, summary=f"Browser activation refused: {reason}", request=request,
        )

    # 2. Account: the code's owner must still be active and in the code's organization.
    if not user or not user.active or user.organization_id != token.organization_id:
        audit_failure(token.organization_id, "account disabled")
        raise _fail(status.HTTP_403_FORBIDDEN, "ACCOUNT_DISABLED", "This account is disabled. Contact your administrator.")

    # 3. The code must be unused, unexpired and not revoked.
    if token.revoked_at is not None:
        audit_failure(user.organization_id, "revoked activation code")
        raise _fail(status.HTTP_400_BAD_REQUEST, "REVOKED", "This activation code was replaced or revoked. Generate a new one.")
    if token.used_at is not None:
        audit_failure(user.organization_id, "activation code already used")
        raise _fail(status.HTTP_400_BAD_REQUEST, "INVALID_TOKEN", "This activation code was already used. Generate a new one.")
    if _aware(token.expires_at) < datetime.now(timezone.utc):
        audit_failure(user.organization_id, "expired activation code")
        raise _fail(status.HTTP_400_BAD_REQUEST, "EXPIRED", "This activation code has expired. Generate a new one.")

    # A code made by the AgentShield Windows app of a connected PC: the browser joins that PC, which
    # already holds a device slot, so the plan's limit is not charged again.
    computer = None
    if token.computer_id:
        computer = db.query(Computer).filter(Computer.id == token.computer_id).first()
        if computer is None or computer.status != "ACTIVE" or computer.user_id != user.id:
            audit_failure(user.organization_id, "PC connection removed")
            raise _fail(status.HTTP_403_FORBIDDEN, "REVOKED", "This PC was removed from your account. Connect it again in the AgentShield app.")

    # 4. Licence: the company must have an active trial or plan, with a free device slot.
    ent = current_entitlement(db, token.organization_id)
    if not ent.allowed:
        code, message = DENIAL_CODES.get(ent.state, DENIAL_CODES["NONE"])
        audit_failure(token.organization_id, f"no active licence ({ent.state})")
        raise _fail(status.HTTP_403_FORBIDDEN, code, message)
    if computer is None and ent.devices_used >= ent.device_limit:
        audit_failure(token.organization_id, "licence browser limit reached")
        raise _fail(
            status.HTTP_409_CONFLICT, "DEVICE_LIMIT",
            f"Your plan allows {ent.device_limit} device{'s' if ent.device_limit != 1 else ''} (browsers or PCs) and all are in use. "
            "Sign one out in the portal, or upgrade.",
        )

    # 5. Device: a valid P-256 public key, within the per-account limit.
    if not is_valid_device_public_key(payload.public_key):
        raise _fail(status.HTTP_400_BAD_REQUEST, "INVALID_DEVICE_KEY", "The browser sent an invalid device key. Reload the extension and try again.")
    if computer is None:
        active_devices = user_slot_count(db, user.id)
        if active_devices >= settings.MAX_DEVICES_PER_USER:
            audit_failure(user.organization_id, "device limit reached")
            raise _fail(
                status.HTTP_409_CONFLICT, "DEVICE_LIMIT",
                f"This account already has {active_devices} browsers or PCs connected. Sign one out in the portal first.",
            )
    else:
        # A PC holds at most MAX_BROWSERS_PER_COMPUTER browsers; the least recently seen one makes room
        # (browser profiles that were deleted or reinstalled leave such entries behind).
        on_pc = (
            db.query(Device)
            .filter(Device.computer_id == computer.id, Device.status != "REVOKED")
            .order_by(func.coalesce(Device.last_seen_at, Device.created_at).asc())
            .all()
        )
        for old in on_pc[: max(0, len(on_pc) - settings.MAX_BROWSERS_PER_COMPUTER + 1)]:
            old.status = "REVOKED"
            old.revoked_at = datetime.now(timezone.utc)
            old.revoked_by = "system:pc-browser-replaced"

    org_settings = get_org_settings(db, user.organization_id)
    now = datetime.now(timezone.utc)
    device = Device(
        organization_id=user.organization_id,
        user_id=user.id,
        public_key=payload.public_key,
        status="PENDING" if org_settings.require_device_approval else "ACTIVE",
        browser=payload.browser,
        platform=payload.platform,
        activation_token_id=token.id,
        computer_id=computer.id if computer else None,
    )
    db.add(device)
    token.used_at = now
    db.commit()
    db.refresh(device)
    where = f" on PC {computer.name or computer.id[:8]} (AgentShield app)" if computer else ""
    record_admin_action(
        db, organization_id=user.organization_id, actor=user.email, action="device.activate",
        target_type="device", target_id=device.id,
        summary=f"Activated a browser ({payload.browser or 'unknown browser'}){where}; status {device.status}",
        request=request,
    )
    return DeviceActivateResponse(
        device_id=device.id, status=device.status,
        organization_name=_org_name(db, user.organization_id), user_email=user.email,
    )


def _usable_device(db: Session, device_id: str) -> Device:
    device = db.query(Device).filter(Device.id == device_id).first()
    if not device:
        raise _fail(status.HTTP_401_UNAUTHORIZED, "DEVICE_UNKNOWN", "This browser is not activated.")
    if device.status == "REVOKED":
        raise _fail(status.HTTP_403_FORBIDDEN, "REVOKED", "This browser's activation was revoked. Activate it again with a new code.")
    if device.status == "PENDING":
        raise _fail(status.HTTP_403_FORBIDDEN, "PENDING_APPROVAL", "Waiting for an administrator to approve this browser.")
    owner = db.query(User).filter(User.id == device.user_id).first()
    if not owner or not owner.active or owner.organization_id != device.organization_id:
        raise _fail(status.HTTP_403_FORBIDDEN, "ACCOUNT_DISABLED", "The account for this browser is disabled. Contact your administrator.")
    if device.computer_id:
        computer = db.query(Computer).filter(Computer.id == device.computer_id).first()
        if computer is None or computer.status != "ACTIVE":
            raise _fail(status.HTTP_403_FORBIDDEN, "REVOKED", "This PC was removed from your account. Connect it again in the AgentShield app.")
    return device


@router.post("/challenge", response_model=DeviceChallengeResponse)
def challenge(payload: DeviceChallengeRequest, request: Request, db: Session = Depends(get_db)):
    ratelimit.hit("device-challenge", f"{ratelimit.client_key(request)}|{payload.device_id}", 30, 10 * 60)
    device = _usable_device(db, payload.device_id)
    nonce = create_access_token(
        subject=device.id,
        expires_delta=timedelta(seconds=CHALLENGE_SECONDS),
        extra_claims={"typ": TOKEN_TYPE_CHALLENGE, "jti": secrets.token_urlsafe(16)},
    )
    return DeviceChallengeResponse(nonce=nonce, expires_in=CHALLENGE_SECONDS)


@router.post("/session", response_model=DeviceSessionResponse)
def session(payload: DeviceSessionRequest, request: Request, db: Session = Depends(get_db)):
    ratelimit.hit("device-session", f"{ratelimit.client_key(request)}|{payload.device_id}", 30, 10 * 60)
    claims = decode_access_token(payload.nonce)
    if not claims or claims.get("typ") != TOKEN_TYPE_CHALLENGE or claims.get("sub") != payload.device_id:
        raise _fail(status.HTTP_401_UNAUTHORIZED, "INVALID_SIGNATURE", "The sign-in challenge is invalid or expired. Try again.")

    now = time.time()
    for jti, exp in list(_used_nonces.items()):
        if exp < now:
            _used_nonces.pop(jti, None)
    jti = str(claims.get("jti") or "")
    if not jti or jti in _used_nonces:
        raise _fail(status.HTTP_401_UNAUTHORIZED, "INVALID_SIGNATURE", "The sign-in challenge was already used. Try again.")

    device = _usable_device(db, payload.device_id)
    if not verify_device_signature(device.public_key, payload.nonce.encode("utf-8"), payload.signature):
        record_admin_action(
            db, organization_id=device.organization_id, actor=f"device:{device.id}", action="device.session_refused",
            target_type="device", target_id=device.id, summary="Device sign-in refused: signature does not match the device key",
            request=request,
        )
        raise _fail(status.HTTP_401_UNAUTHORIZED, "INVALID_SIGNATURE", "This browser could not prove its identity. Activate it again.")
    _used_nonces[jti] = float(claims.get("exp", now + CHALLENGE_SECONDS))

    # The company's licence decides whether a session is issued at all, and caps its lifetime.
    ent = current_entitlement(db, device.organization_id)
    if not ent.allowed:
        code, message = DENIAL_CODES.get(ent.state, DENIAL_CODES["NONE"])
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": code, "message": message, "entitlement": ent.as_dict()},
        )
    seconds = settings.DEVICE_SESSION_MINUTES * 60
    if ent.expires_at is not None:
        seconds = max(1, min(seconds, int((aware(ent.expires_at) - utcnow()).total_seconds())))

    owner = db.query(User).filter(User.id == device.user_id).first()
    token = create_access_token(
        subject=device.id,
        expires_delta=timedelta(seconds=seconds),
        extra_claims={"typ": TOKEN_TYPE_DEVICE, "uid": device.user_id, "org": device.organization_id},
    )
    device.last_seen_at = datetime.now(timezone.utc)
    db.commit()
    return DeviceSessionResponse(
        session_token=token,
        expires_in=seconds,
        device_id=device.id,
        user_email=owner.email if owner else "",
        organization_id=device.organization_id,
        organization_name=_org_name(db, device.organization_id),
        entitlement=ent.as_dict(),
    )


@router.post("/deactivate", status_code=status.HTTP_204_NO_CONTENT)
def deactivate(request: Request, principal: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    """"Sign out this browser" from the extension: revokes the calling device."""
    if principal.device is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only an activated browser can sign itself out.")
    device = principal.device
    device.status = "REVOKED"
    device.revoked_at = datetime.now(timezone.utc)
    device.revoked_by = principal.user.email if principal.user else "device"
    db.commit()
    record_admin_action(
        db, organization_id=device.organization_id, actor=device.revoked_by, action="device.sign_out",
        target_type="device", target_id=device.id, summary="Signed out a browser from the extension", request=request,
    )
    return None
