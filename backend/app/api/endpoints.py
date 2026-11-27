"""Protected Endpoint (browser) Inventory.

Each enrolled extension sends a heartbeat after every policy sync (about every
5 minutes). The dashboard uses these to show how many browsers are protected,
which are online, and which have not picked up the latest policy version.
Only metadata is stored: a random per-browser ID, the employee ID, extension
version, browser name and OS. No browsing history.
"""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import Principal, employee_id_for, get_current_user, get_principal
from app.api.schemas import EndpointHeartbeat, EndpointOut, EndpointSummary
from app.core.policy_revision import current_policy_revision
from app.db.models import Endpoint, Policy, User
from app.db.session import get_db

router = APIRouter(prefix="/api/v1/endpoints", tags=["Endpoints"])

ONLINE_WINDOW = timedelta(minutes=15)
STALE_WINDOW = timedelta(hours=24)


def current_policy_version(db: Session, organization_id: str) -> int:
    value = db.query(func.max(Policy.version)).filter(Policy.organization_id == organization_id).scalar()
    return int(value or 1)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


@router.post("/heartbeat", status_code=status.HTTP_204_NO_CONTENT)
def heartbeat(
    payload: EndpointHeartbeat,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    """Records that an activated browser is alive. Devices only.

    For activated devices the browser ID and employee come from the authorized device
    record, not from the request body.
    """
    if not principal.is_device:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Heartbeats are sent by the extension.")
    now = datetime.now(timezone.utc)
    device_id = principal.device.id if principal.device is not None else payload.device_id
    row = (
        db.query(Endpoint)
        .filter(Endpoint.organization_id == principal.organization_id, Endpoint.device_id == device_id)
        .first()
    )
    if not row:
        row = Endpoint(organization_id=principal.organization_id, device_id=device_id, first_seen_at=now)
        db.add(row)
    row.user_id = employee_id_for(principal, payload.user_id)
    row.device_key_id = principal.device_key.id if principal.device_key else None
    row.extension_version = payload.extension_version
    row.browser = payload.browser
    row.platform = payload.platform
    row.policy_version = payload.policy_version
    row.secret_policy_active = payload.secret_policy_active
    row.applied_policy_revision = payload.applied_policy_revision
    row.enrollment_source = "activation" if principal.device is not None else payload.enrollment_source
    row.last_seen_at = now
    db.commit()
    return None


@router.get("", response_model=EndpointSummary)
def list_endpoints(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """All browsers that have checked in, with online/stale/offline status and policy currency."""
    org_id = current_user.organization_id
    latest = current_policy_version(db, org_id)
    revision = current_policy_revision(db, org_id)
    now = datetime.now(timezone.utc)
    rows = (
        db.query(Endpoint)
        .filter(Endpoint.organization_id == org_id)
        .order_by(Endpoint.last_seen_at.desc())
        .all()
    )

    items = []
    counts = {"ONLINE": 0, "STALE": 0, "OFFLINE": 0}
    outdated = 0
    for r in rows:
        age = now - _aware(r.last_seen_at) if r.last_seen_at else STALE_WINDOW * 2
        state = "ONLINE" if age <= ONLINE_WINDOW else "STALE" if age <= STALE_WINDOW else "OFFLINE"
        counts[state] += 1
        is_current = (r.policy_version or 0) >= latest
        if not is_current:
            outdated += 1
        out = EndpointOut.model_validate(r)
        if r.applied_policy_revision != revision or state != "ONLINE":
            out.secret_policy_active = None
        out.status = state
        out.policy_current = is_current
        items.append(out)

    return EndpointSummary(
        total=len(rows),
        online=counts["ONLINE"],
        stale=counts["STALE"],
        offline=counts["OFFLINE"],
        outdated_policy=outdated,
        current_policy_version=latest,
        items=items,
    )
