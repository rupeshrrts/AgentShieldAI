"""Central permission model.

Every internal (staff) route declares the permission it needs with `require_staff("<perm>")`;
a role name alone never grants access. Staff authenticate with their own token type (typ=staff),
so customer and device tokens are never accepted here, and staff tokens are refused by the
customer dependencies in api/deps.py (they only accept typ=user / typ=device).
"""
from typing import Callable, Dict, FrozenSet, Optional

from fastapi import Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.security import decode_access_token
from app.db.models import StaffUser
from app.db.session import get_db

TOKEN_TYPE_STAFF = "staff"
TOKEN_TYPE_STAFF_MFA = "staff_mfa"              # password checked, waiting for the authenticator code
TOKEN_TYPE_STAFF_MFA_SETUP = "staff_mfa_setup"  # password checked, authenticator not enrolled yet

OWNER, ADMIN, SECURITY, SUPPORT, BILLING, READONLY = (
    "PLATFORM_OWNER", "PLATFORM_ADMIN", "SECURITY_ANALYST", "SUPPORT_AGENT", "BILLING_ADMIN", "READONLY_ANALYST",
)
STAFF_ROLES = (OWNER, ADMIN, SECURITY, SUPPORT, BILLING, READONLY)
STAFF_ROLE_LABELS = {
    OWNER: "Platform owner", ADMIN: "Platform administrator", SECURITY: "Security analyst",
    SUPPORT: "Support agent", BILLING: "Billing administrator", READONLY: "Read-only analyst",
}

ALL = frozenset(STAFF_ROLES)

# permission -> roles that hold it
STAFF_PERMISSIONS: Dict[str, FrozenSet[str]] = {
    "companies.read":     ALL,
    "companies.suspend":  frozenset({OWNER, ADMIN}),
    "users.suspend":      frozenset({OWNER, ADMIN}),
    "devices.read":       frozenset({OWNER, ADMIN, SECURITY, SUPPORT}),
    "licenses.manage":    frozenset({OWNER, ADMIN}),
    "licenses.exception": frozenset({OWNER}),   # licence without a verified payment: reason required, audited
    "plans.read":         frozenset({OWNER, ADMIN, BILLING, READONLY}),
    "plans.manage":       frozenset({OWNER}),
    "releases.read":      frozenset({OWNER, ADMIN, SECURITY, SUPPORT, READONLY}),
    "releases.manage":    frozenset({OWNER, ADMIN}),
    "billing.read":       frozenset({OWNER, BILLING, READONLY}),
    "billing.refund":     frozenset({OWNER, BILLING}),
    "billing.reconcile":  frozenset({OWNER, BILLING}),
    "audit.read":         frozenset({OWNER, ADMIN, SECURITY}),
    "metrics.read":       frozenset({OWNER, ADMIN, SECURITY, BILLING, READONLY}),
    "jobs.run":           frozenset({OWNER, ADMIN}),
    "staff.manage":       frozenset({OWNER}),
}


def staff_permissions(role: str) -> list:
    return sorted(p for p, roles in STAFF_PERMISSIONS.items() if role in roles)


def staff_has(role: str, permission: str) -> bool:
    return role in STAFF_PERMISSIONS.get(permission, frozenset())


_bearer = HTTPBearer(auto_error=False)


def _unauthorized(detail: str = "Sign in to the internal console.") -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail, headers={"WWW-Authenticate": "Bearer"})


def staff_from_token(token: Optional[str], db: Session, expected_type: str = TOKEN_TYPE_STAFF) -> Optional[StaffUser]:
    payload = decode_access_token(token) if token else None
    if not payload or payload.get("typ") != expected_type:
        return None
    staff = db.query(StaffUser).filter(StaffUser.id == payload.get("sub"), StaffUser.active == True).first()
    if staff is None or int(payload.get("sv", -1)) != (staff.session_version or 0):
        return None
    return staff


def get_staff_session(
    credentials: Optional[HTTPAuthorizationCredentials] = Security(_bearer),
    db: Session = Depends(get_db),
) -> StaffUser:
    """A signed-in, MFA-verified staff member; a pending password change is still allowed here."""
    staff = staff_from_token(credentials.credentials if credentials else None, db)
    if staff is None or staff.totp_enabled_at is None:
        raise _unauthorized()
    return staff


def require_staff(permission: str) -> Callable[..., StaffUser]:
    """Dependency factory: MFA-verified staff session, password already changed, and the permission held."""
    if permission not in STAFF_PERMISSIONS:
        raise RuntimeError(f"Unknown permission {permission}")

    def dependency(staff: StaffUser = Depends(get_staff_session)) -> StaffUser:
        if staff.must_change_password:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail={"code": "PASSWORD_CHANGE_REQUIRED", "message": "Change your temporary password first."})
        if not staff_has(staff.role, permission):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail={"code": "FORBIDDEN", "message": f"Your role does not allow this ({permission})."})
        return staff

    return dependency
