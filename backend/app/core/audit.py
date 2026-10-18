"""Administrative audit trail.

Every change an operator makes (policies, domains, keywords, settings, device keys,
employee actions, passwords) and every sign-in attempt is recorded in
`admin_audit_log`. Details hold before/after values, never secrets or passwords.
"""

import json
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import Request
from sqlalchemy.orm import Session

from app.db.models import AdminAuditLog


def snapshot(obj: Any, fields: list) -> dict:
    """Returns the given attributes of a model as a JSON-safe dict."""
    out = {}
    for f in fields:
        value = getattr(obj, f, None)
        if isinstance(value, datetime):
            value = value.isoformat()
        out[f] = value
    return out


def client_ip(request: Optional[Request]) -> Optional[str]:
    if request is None:
        return None
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    return request.client.host[:64] if request.client else None


def record_admin_action(
    db: Session,
    *,
    organization_id: Optional[str],
    actor: Optional[str],
    action: str,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    summary: Optional[str] = None,
    before: Optional[dict] = None,
    after: Optional[dict] = None,
    request: Optional[Request] = None,
    commit: bool = True,
    actor_type: str = "customer",
) -> None:
    """Writes one audit entry. Failures never break the admin action itself."""
    try:
        details = None
        if before is not None or after is not None:
            details = json.dumps({"before": before, "after": after}, default=str)[:8000]
        db.add(AdminAuditLog(
            organization_id=organization_id,
            occurred_at=datetime.now(timezone.utc),
            actor=(actor or "")[:255] or None,
            action=action,
            target_type=target_type,
            target_id=(target_id or "")[:255] or None,
            summary=(summary or "")[:500] or None,
            details=details,
            ip_address=client_ip(request),
            actor_type=actor_type,
        ))
        if commit:
            db.commit()
    except Exception:
        db.rollback()
