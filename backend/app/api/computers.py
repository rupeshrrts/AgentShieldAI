"""PCs connected once with a portal code (2.4): the retired AgentShield Windows app, and today the optional
Network Agent (agent/), which uses the same flow.

Since 2.6 the browser extension no longer talks to the Windows app (no native messaging), and the Windows
app and its setup .exe were removed from the repository. PCs connected earlier stay listed until removed.
The flow:

1. POST /api/v1/computer/activate   The app sends a single-use activation code the person generated while
                                    signed in to the portal (pasted into the app, or handed over by the
                                    portal's "Connect this PC" button), plus the public half of a key pair it
                                    just created in the Windows user's key store (non-exportable). The PC is
                                    bound to that account and uses ONE device slot of the plan.
2. POST /api/v1/computer/challenge  One-time nonce (60 s) for that PC.
3. POST /api/v1/computer/browser-code
                                    The app signs the nonce; the server returns a fresh single-use activation
                                    code (5 minutes) linked to the PC. The extension in each browser asks the
                                    app for one and activates exactly as with a pasted code
                                    (api/device_auth.py), so every browser still gets its own key and its own
                                    15-minute sessions, and the server checks every request.
   POST /api/v1/computer/status      Signed: is this PC still connected, and to which account.
   POST /api/v1/computer/deactivate  Signed: "Disconnect this PC" / uninstall. Removes the PC and its browsers.

The portal lists and removes PCs at /api/v1/me/computers. Nothing here trusts the request for the account
or organization: both come from the activation code or the PC's stored record.
"""
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.deps import get_signed_in_user
from app.api.schemas import DeviceOut
from app.core import ratelimit
from app.core.audit import record_admin_action
from app.core.config import settings
from app.core.entitlements import DENIAL_CODES, current_entitlement, user_slot_count
from app.core.security import (
    ACTIVATION_TOKEN_PREFIX,
    create_access_token,
    decode_access_token,
    generate_secret,
    hash_device_key,
    is_valid_device_public_key,
    verify_device_signature,
)
from app.db.models import ActivationToken, Computer, Device, Organization, User
from app.db.session import get_db

router = APIRouter(prefix="/api/v1/computer", tags=["AgentShield Windows app"])
me_router = APIRouter(prefix="/api/v1/me", tags=["My activation"])

TOKEN_TYPE_COMPUTER_CHALLENGE = "computer_challenge"
CHALLENGE_SECONDS = 60
BROWSER_CODE_MINUTES = 5

# Nonces already used (per process), so a captured signature cannot be replayed.
_used_nonces: Dict[str, float] = {}


# ---------------------------------------------------------------- schemas

class ComputerActivateRequest(BaseModel):
    activation_token: str = Field(..., min_length=10, max_length=200)
    public_key: str = Field(..., min_length=40, max_length=400)  # base64 SPKI, ECDSA P-256
    name: Optional[str] = Field(default=None, max_length=120)
    platform: Optional[str] = Field(default=None, max_length=60)


class ComputerActivateResponse(BaseModel):
    computer_id: str
    organization_name: str
    user_email: str


class ComputerChallengeRequest(BaseModel):
    computer_id: str = Field(..., min_length=8, max_length=64)


class ComputerChallengeResponse(BaseModel):
    nonce: str
    expires_in: int


class ComputerSignedRequest(BaseModel):
    computer_id: str = Field(..., min_length=8, max_length=64)
    nonce: str = Field(..., min_length=10, max_length=2000)
    signature: str = Field(..., min_length=40, max_length=200)  # base64 raw r||s
    browser: Optional[str] = Field(default=None, max_length=120)


class BrowserCodeResponse(BaseModel):
    token: str          # single-use asa_ activation token, shown to that one browser only
    api_url: str
    expires_in: int


class ComputerStatusResponse(BaseModel):
    computer_id: str
    status: str
    user_email: str
    organization_name: str
    browsers: int
    entitlement_state: str


class ComputerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: Optional[str] = None
    platform: Optional[str] = None
    status: str
    created_at: Optional[datetime] = None
    last_seen_at: Optional[datetime] = None
    revoked_at: Optional[datetime] = None
    revoked_by: Optional[str] = None
    browsers: List[DeviceOut] = []


# ---------------------------------------------------------------- helpers

def _fail(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _api_base_url(request: Request) -> str:
    return settings.PUBLIC_BASE_URL or str(request.base_url).rstrip("/")


def _org_name(db: Session, organization_id: str) -> str:
    org = db.query(Organization).filter(Organization.id == organization_id).first()
    return org.name if org else ""


def revoke_computer(db: Session, computer: Computer, actor: str) -> int:
    """Removes a PC and every browser connected through it. Returns the number of browsers signed out."""
    now = _now()
    computer.status = "REVOKED"
    computer.revoked_at = now
    computer.revoked_by = actor
    count = 0
    for device in db.query(Device).filter(Device.computer_id == computer.id, Device.status != "REVOKED"):
        device.status = "REVOKED"
        device.revoked_at = now
        device.revoked_by = actor
        count += 1
    for token in db.query(ActivationToken).filter(
        ActivationToken.computer_id == computer.id, ActivationToken.used_at.is_(None), ActivationToken.revoked_at.is_(None)
    ):
        token.revoked_at = now
    db.commit()
    return count


def _usable_computer(db: Session, computer_id: str) -> tuple:
    computer = db.query(Computer).filter(Computer.id == computer_id).first()
    if not computer:
        raise _fail(status.HTTP_401_UNAUTHORIZED, "DEVICE_UNKNOWN", "This PC is not connected. Connect it again in the AgentShield app.")
    if computer.status != "ACTIVE":
        raise _fail(status.HTTP_403_FORBIDDEN, "REVOKED", "This PC was removed from your account. Connect it again in the AgentShield app.")
    owner = db.query(User).filter(User.id == computer.user_id).first()
    if not owner or not owner.active or owner.organization_id != computer.organization_id:
        raise _fail(status.HTTP_403_FORBIDDEN, "ACCOUNT_DISABLED", "The account for this PC is disabled. Contact your administrator.")
    return computer, owner


def _verify_signed(db: Session, payload: ComputerSignedRequest, request: Request) -> tuple:
    """Checks a fresh, unused challenge signed with the PC's key. Returns (computer, owner)."""
    claims = decode_access_token(payload.nonce)
    if not claims or claims.get("typ") != TOKEN_TYPE_COMPUTER_CHALLENGE or claims.get("sub") != payload.computer_id:
        raise _fail(status.HTTP_401_UNAUTHORIZED, "INVALID_SIGNATURE", "The sign-in challenge is invalid or expired. Try again.")
    now = time.time()
    for jti, exp in list(_used_nonces.items()):
        if exp < now:
            _used_nonces.pop(jti, None)
    jti = str(claims.get("jti") or "")
    if not jti or jti in _used_nonces:
        raise _fail(status.HTTP_401_UNAUTHORIZED, "INVALID_SIGNATURE", "The sign-in challenge was already used. Try again.")

    computer, owner = _usable_computer(db, payload.computer_id)
    if not verify_device_signature(computer.public_key, payload.nonce.encode("utf-8"), payload.signature):
        record_admin_action(
            db, organization_id=computer.organization_id, actor=f"computer:{computer.id}", action="computer.session_refused",
            target_type="computer", target_id=computer.id, summary="PC request refused: signature does not match the PC key",
            request=request,
        )
        raise _fail(status.HTTP_401_UNAUTHORIZED, "INVALID_SIGNATURE", "This PC could not prove its identity. Connect it again.")
    _used_nonces[jti] = float(claims.get("exp", now + CHALLENGE_SECONDS))
    computer.last_seen_at = _now()
    db.commit()
    return computer, owner


# ---------------------------------------------------------------- the Windows app

@router.post("/activate", response_model=ComputerActivateResponse, status_code=status.HTTP_201_CREATED)
def activate_computer(payload: ComputerActivateRequest, request: Request, db: Session = Depends(get_db)):
    ip = ratelimit.client_key(request)
    ratelimit.hit("activate-ip", ip, 10, 60 * 60, "Too many activation attempts from this network. Try again later.")

    raw = payload.activation_token.strip()
    token = db.query(ActivationToken).filter(ActivationToken.token_hash == hash_device_key(raw)).first()
    if not token:
        record_admin_action(
            db, organization_id=None, actor=f"ip:{ip}", action="computer.activate_failed",
            target_type="computer", target_id=raw[:10], summary="PC connection refused: unknown activation code", request=request,
        )
        raise _fail(status.HTTP_400_BAD_REQUEST, "INVALID_TOKEN", "This activation code is not valid. Generate a new one in the portal.")
    user = db.query(User).filter(User.id == token.user_id).first()

    def audit_failure(reason: str):
        record_admin_action(
            db, organization_id=token.organization_id, actor=user.email if user else token.user_id,
            action="computer.activate_failed", target_type="computer", target_id=token.token_prefix,
            summary=f"PC connection refused: {reason}", request=request,
        )

    if not user or not user.active or user.organization_id != token.organization_id:
        audit_failure("account disabled")
        raise _fail(status.HTTP_403_FORBIDDEN, "ACCOUNT_DISABLED", "This account is disabled. Contact your administrator.")
    # Codes a PC made for its own browsers cannot connect another PC
    if token.computer_id:
        audit_failure("browser code used for a PC")
        raise _fail(status.HTTP_400_BAD_REQUEST, "INVALID_TOKEN", "This activation code is not valid for a PC. Generate a new one in the portal.")
    if token.revoked_at is not None:
        audit_failure("revoked activation code")
        raise _fail(status.HTTP_400_BAD_REQUEST, "REVOKED", "This activation code was replaced or revoked. Generate a new one.")
    if token.used_at is not None:
        audit_failure("activation code already used")
        raise _fail(status.HTTP_400_BAD_REQUEST, "INVALID_TOKEN", "This activation code was already used. Generate a new one.")
    if _aware(token.expires_at) < _now():
        audit_failure("expired activation code")
        raise _fail(status.HTTP_400_BAD_REQUEST, "EXPIRED", "This activation code has expired. Generate a new one.")

    ent = current_entitlement(db, token.organization_id)
    if not ent.allowed:
        code, message = DENIAL_CODES.get(ent.state, DENIAL_CODES["NONE"])
        audit_failure(f"no active licence ({ent.state})")
        raise _fail(status.HTTP_403_FORBIDDEN, code, message)
    if ent.devices_used >= ent.device_limit:
        audit_failure("licence device limit reached")
        raise _fail(
            status.HTTP_409_CONFLICT, "DEVICE_LIMIT",
            f"Your plan allows {ent.device_limit} device{'s' if ent.device_limit != 1 else ''} (browsers or PCs) and all are in use. "
            "Sign one out in the portal, or upgrade.",
        )
    if not is_valid_device_public_key(payload.public_key):
        raise _fail(status.HTTP_400_BAD_REQUEST, "INVALID_DEVICE_KEY", "The AgentShield app sent an invalid key. Reinstall it and try again.")
    used = user_slot_count(db, user.id)
    if used >= settings.MAX_DEVICES_PER_USER:
        audit_failure("device limit reached")
        raise _fail(
            status.HTTP_409_CONFLICT, "DEVICE_LIMIT",
            f"This account already has {used} browsers or PCs connected. Sign one out in the portal first.",
        )

    computer = Computer(
        organization_id=user.organization_id, user_id=user.id, public_key=payload.public_key,
        name=(payload.name or "").strip()[:120] or None, platform=(payload.platform or "").strip()[:60] or None,
        status="ACTIVE", activation_token_id=token.id, last_seen_at=_now(),
    )
    db.add(computer)
    token.used_at = _now()
    db.commit()
    db.refresh(computer)
    record_admin_action(
        db, organization_id=user.organization_id, actor=user.email, action="computer.activate",
        target_type="computer", target_id=computer.id,
        summary=f"Connected a PC through the AgentShield app ({computer.name or 'unnamed PC'})", request=request,
    )
    return ComputerActivateResponse(computer_id=computer.id, organization_name=_org_name(db, user.organization_id), user_email=user.email)


@router.post("/challenge", response_model=ComputerChallengeResponse)
def computer_challenge(payload: ComputerChallengeRequest, request: Request, db: Session = Depends(get_db)):
    ratelimit.hit("computer-challenge", f"{ratelimit.client_key(request)}|{payload.computer_id}", 60, 10 * 60)
    computer, _owner = _usable_computer(db, payload.computer_id)
    nonce = create_access_token(
        subject=computer.id, expires_delta=timedelta(seconds=CHALLENGE_SECONDS),
        extra_claims={"typ": TOKEN_TYPE_COMPUTER_CHALLENGE, "jti": secrets.token_urlsafe(16)},
    )
    return ComputerChallengeResponse(nonce=nonce, expires_in=CHALLENGE_SECONDS)


@router.post("/browser-code", response_model=BrowserCodeResponse, status_code=status.HTTP_201_CREATED)
def browser_code(payload: ComputerSignedRequest, request: Request, db: Session = Depends(get_db)):
    """A single-use activation code for one browser on this PC (asked for by the extension through the app)."""
    ratelimit.hit("computer-browser-code", payload.computer_id, 30, 60 * 60, "Too many browser connections from this PC. Try again later.")
    computer, owner = _verify_signed(db, payload, request)
    ent = current_entitlement(db, computer.organization_id)
    if not ent.allowed:
        code, message = DENIAL_CODES.get(ent.state, DENIAL_CODES["NONE"])
        raise _fail(status.HTTP_403_FORBIDDEN, code, message)
    now = _now()
    # Only the newest code of this PC is valid
    for old in db.query(ActivationToken).filter(
        ActivationToken.computer_id == computer.id, ActivationToken.used_at.is_(None), ActivationToken.revoked_at.is_(None)
    ):
        old.revoked_at = now
    token = generate_secret(ACTIVATION_TOKEN_PREFIX)
    row = ActivationToken(
        organization_id=computer.organization_id, user_id=owner.id, token_hash=hash_device_key(token),
        token_prefix=token[:10], expires_at=now + timedelta(minutes=BROWSER_CODE_MINUTES), computer_id=computer.id,
    )
    db.add(row)
    db.commit()
    record_admin_action(
        db, organization_id=computer.organization_id, actor=owner.email, action="activation_token.create",
        target_type="activation_token", target_id=row.token_prefix,
        summary=f"AgentShield app on PC {computer.name or computer.id[:8]} created a browser activation code"
                + (f" ({payload.browser})" if payload.browser else ""),
        request=request,
    )
    return BrowserCodeResponse(token=token, api_url=_api_base_url(request), expires_in=BROWSER_CODE_MINUTES * 60)


@router.post("/status", response_model=ComputerStatusResponse)
def computer_status(payload: ComputerSignedRequest, request: Request, db: Session = Depends(get_db)):
    ratelimit.hit("computer-status", payload.computer_id, 60, 60 * 60)
    computer, owner = _verify_signed(db, payload, request)
    browsers = db.query(Device).filter(Device.computer_id == computer.id, Device.status != "REVOKED").count()
    ent = current_entitlement(db, computer.organization_id)
    return ComputerStatusResponse(
        computer_id=computer.id, status=computer.status, user_email=owner.email,
        organization_name=_org_name(db, computer.organization_id), browsers=browsers, entitlement_state=ent.state,
    )


@router.post("/deactivate", status_code=status.HTTP_204_NO_CONTENT)
def computer_deactivate(payload: ComputerSignedRequest, request: Request, db: Session = Depends(get_db)):
    """"Disconnect this PC" in the app (also run on uninstall): removes the PC and signs out its browsers."""
    computer, owner = _verify_signed(db, payload, request)
    count = revoke_computer(db, computer, owner.email)
    record_admin_action(
        db, organization_id=computer.organization_id, actor=owner.email, action="computer.disconnect",
        target_type="computer", target_id=computer.id,
        summary=f"Disconnected PC {computer.name or computer.id[:8]} from the AgentShield app ({count} browser(s) signed out)",
        request=request,
    )
    return None


# ---------------------------------------------------------------- portal: own PCs

def computer_view(db: Session, computer: Computer, emails: dict) -> ComputerOut:
    out = ComputerOut.model_validate(computer)
    devices = (
        db.query(Device).filter(Device.computer_id == computer.id, Device.status != "REVOKED")
        .order_by(Device.created_at.asc()).all()
    )
    browsers = []
    for d in devices:
        item = DeviceOut.model_validate(d)
        item.user_email = emails.get(d.user_id)
        item.computer_name = computer.name
        browsers.append(item)
    out.browsers = browsers
    return out


@me_router.get("/computers", response_model=List[ComputerOut])
def my_computers(user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)):
    rows = (
        db.query(Computer).filter(Computer.user_id == user.id, Computer.status == "ACTIVE")
        .order_by(Computer.created_at.desc()).all()
    )
    return [computer_view(db, c, {user.id: user.email}) for c in rows]


@me_router.post("/computers/{computer_id}/revoke", response_model=ComputerOut)
def revoke_my_computer(computer_id: str, request: Request, user: User = Depends(get_signed_in_user),
                       db: Session = Depends(get_db)):
    computer = db.query(Computer).filter(Computer.id == computer_id, Computer.user_id == user.id).first()
    if not computer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PC not found.")
    if computer.status != "REVOKED":
        count = revoke_computer(db, computer, user.email)
        record_admin_action(
            db, organization_id=user.organization_id, actor=user.email, action="computer.revoke",
            target_type="computer", target_id=computer.id,
            summary=f"Removed PC {computer.name or computer.id[:8]} ({count} browser(s) signed out)", request=request,
        )
    return computer_view(db, computer, {user.id: user.email})
