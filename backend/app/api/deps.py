"""API dependencies for authentication, tenant scoping, and authorization.

Callers:
1. Dashboard operators (ADMIN, VIEWER), who sign in and send a JWT bearer token.
2. Employees (EMPLOYEE), who sign in only to generate activation codes and manage
   their own devices (/auth/*, /api/v1/me/*). They cannot read organization data.
3. Browser extensions, which send a short-lived device session JWT (typ=device)
   obtained by proving possession of the device's private key. Every request
   re-checks that the device is ACTIVE and its user and organization are active.
   The organization is always taken from the credential, never from the request body.
4. Legacy organization-wide device keys (`X-Device-Key`), only when
   LEGACY_DEVICE_KEYS_ENABLED is set.
"""
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Deque, Dict, Optional

from fastapi import Depends, Header, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.entitlements import DENIAL_CODES, current_entitlement
from app.core.security import TOKEN_TYPE_DEVICE, TOKEN_TYPE_USER, decode_access_token, hash_device_key
from app.db.models import Device, DeviceKey, Organization, User
from app.db.session import get_db

security_scheme = HTTPBearer(auto_error=False)

OPERATOR_ROLES = ("ADMIN", "VIEWER")


@dataclass
class Principal:
    """The authenticated caller of an endpoint that accepts operators or devices."""
    organization_id: str
    actor_id: str            # Dashboard user ID, 'device:<device id>' or 'devicekey:<key id>'
    is_device: bool
    user: Optional[User] = None            # Operator, or the account a device belongs to
    device: Optional[Device] = None
    device_key: Optional[DeviceKey] = None  # Legacy only


def _unauthorized(detail: str = "Missing or expired authentication credentials.") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _forbidden(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


def _decode(credentials: Optional[HTTPAuthorizationCredentials]) -> Optional[dict]:
    if not credentials:
        return None
    payload = decode_access_token(credentials.credentials)
    if not payload or "sub" not in payload:
        return None
    return payload


def _user_from_payload(payload: Optional[dict], db: Session) -> Optional[User]:
    if not payload or payload.get("typ", TOKEN_TYPE_USER) != TOKEN_TYPE_USER:
        return None
    user = db.query(User).filter(User.id == payload.get("sub"), User.active == True).first()
    # Tokens issued before a password change/reset or "sign out everywhere" no longer work
    if user and int(payload.get("sv", 0)) != (user.session_version or 0):
        return None
    return user


def _device_from_payload(payload: Optional[dict], db: Session) -> Optional[Device]:
    """Resolves a device session token, re-checking device, user, organization and licence on every call."""
    if not payload or payload.get("typ") != TOKEN_TYPE_DEVICE:
        return None
    device = db.query(Device).filter(Device.id == payload.get("sub")).first()
    if not device or device.status != "ACTIVE":
        return None
    if device.user_id != payload.get("uid") or device.organization_id != payload.get("org"):
        return None
    owner = db.query(User).filter(User.id == device.user_id, User.active == True).first()
    if not owner or owner.organization_id != device.organization_id:
        return None
    # The company's licence is checked on every request; a scheduled job is never relied on
    ent = current_entitlement(db, device.organization_id)
    if not ent.allowed:
        code, message = DENIAL_CODES.get(ent.state, DENIAL_CODES["NONE"])
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"code": code, "message": message})
    now = datetime.now(timezone.utc)
    last = device.last_seen_at
    if last is not None and last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    if last is None or now - last > timedelta(minutes=1):
        device.last_seen_at = now
        db.commit()
    return device


def _device_from_key(raw_key: Optional[str], db: Session) -> Optional[DeviceKey]:
    if not settings.LEGACY_DEVICE_KEYS_ENABLED or not raw_key or not raw_key.strip():
        return None
    device = (
        db.query(DeviceKey)
        .filter(DeviceKey.key_hash == hash_device_key(raw_key.strip()), DeviceKey.active == True)
        .first()
    )
    if device:
        # Record last use at most once a minute to avoid a write on every request
        now = datetime.now(timezone.utc)
        last = device.last_used_at
        if last is not None and last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        if last is None or now - last > timedelta(minutes=1):
            device.last_used_at = now
            db.commit()
    return device


def get_signed_in_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Security(security_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Any signed-in account, including employees (own profile, password, activation, devices)."""
    user = _user_from_payload(_decode(credentials), db)
    if not user:
        raise _unauthorized()
    return user


def get_current_user(user: User = Depends(get_signed_in_user)) -> User:
    """Requires a dashboard operator (ADMIN or VIEWER). Employees cannot read organization data."""
    if user.role not in OPERATOR_ROLES:
        raise _forbidden("This account can only manage its own browser activations.")
    return user


def get_principal(
    credentials: Optional[HTTPAuthorizationCredentials] = Security(security_scheme),
    x_device_key: Optional[str] = Header(default=None, alias="X-Device-Key"),
    db: Session = Depends(get_db),
) -> Principal:
    """Accepts a dashboard operator token or an activated device's session token."""
    payload = _decode(credentials)

    device = _device_from_payload(payload, db)
    if device:
        owner = db.query(User).filter(User.id == device.user_id).first()
        return Principal(
            organization_id=device.organization_id,
            actor_id=f"device:{device.id}",
            is_device=True,
            user=owner,
            device=device,
        )

    user = _user_from_payload(payload, db)
    if user:
        if user.role not in OPERATOR_ROLES:
            raise _forbidden("Employee accounts cannot call this endpoint. Activate the browser extension instead.")
        return Principal(organization_id=user.organization_id, actor_id=user.id, is_device=False, user=user)

    legacy = _device_from_key(x_device_key, db)
    if legacy:
        return Principal(
            organization_id=legacy.organization_id,
            actor_id=f"devicekey:{legacy.id}",
            is_device=True,
            device_key=legacy,
        )

    raise _unauthorized("This browser is not activated, or its session expired.")


def employee_id_for(principal: Principal, claimed: Optional[str]) -> str:
    """Employee recorded on events and heartbeats.

    An activated device always reports as its account's email; a value in the request
    body is ignored, so one employee cannot attribute activity to another.
    """
    if principal.device is not None and principal.user is not None:
        return principal.user.email
    return (claimed or "").strip() or principal.actor_id


def get_current_admin(
    current_user: User = Depends(get_current_user),
) -> User:
    """Administrator of their own company. Platform-wide administration is the internal console
    (staff accounts, core/permissions.py); no customer role can reach it."""
    if current_user.role != "ADMIN":
        raise _forbidden("Insufficient permissions. Administrator role required.")
    return current_user


def require_company_workspace(user: User = Depends(get_signed_in_user), db: Session = Depends(get_db)) -> User:
    """Company-management features (inviting people, managing other accounts and their browsers).

    Individual accounts get 403 COMPANY_FEATURE_UNAVAILABLE: company workspaces are "coming soon" for the
    public. Existing company tenants keep these features.
    """
    org = db.query(Organization).filter(Organization.id == user.organization_id).first()
    if org is None or (org.account_type or "COMPANY") != "COMPANY":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={
            "code": "COMPANY_FEATURE_UNAVAILABLE",
            "message": "Company workspaces are coming soon. This feature is not available for individual accounts.",
        })
    return user


# --- Simple in-memory rate limiting (per process) ---
_event_windows: Dict[str, Deque[float]] = defaultdict(deque)


def enforce_device_rate_limit(principal: Principal, employee_id: Optional[str]) -> None:
    """Caps events per device and employee per minute, so a compromised device cannot flood the audit log."""
    if not principal.is_device:
        return
    limit = settings.DEVICE_EVENTS_PER_MINUTE
    now = time.monotonic()
    window = _event_windows[f"{principal.actor_id}|{employee_id or '-'}"]
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many events from this device. Try again shortly.",
        )
    window.append(now)
