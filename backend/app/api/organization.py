"""Organization Configuration API Endpoints.

Everything an administrator manages from the dashboard's Deployment & Settings page:
1. Legacy device keys (only with LEGACY_DEVICE_KEYS_ENABLED; browsers are now activated
   per user, see api/users.py and api/device_auth.py).
2. Restricted keywords: confidential codewords synced to every extension.
3. Privacy settings: whether prompt text is stored, how long events are kept,
   and whether unapproved AI websites are blocked.
4. The administrative audit log.
"""

import json
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin, get_current_user
from app.api.schemas import (
    AuditLogPage,
    DeviceKeyCreate,
    DeviceKeyCreated,
    DeviceKeyOut,
    KeywordCreate,
    KeywordOut,
    OrgSettingsOut,
    OrgSettingsUpdate,
)
from app.core.audit import record_admin_action
from app.core.catalog import (
    WEB_CATEGORIES,
    WEB_CATEGORY_GROUPS,
    WEB_CATEGORY_IDS,
    WEB_CATEGORY_PRESETS,
    effective_safe_search,
    effective_web_categories,
)
from app.core.config import settings as app_settings
from app.core.policy_revision import bump_policy_revision
from app.core.security import generate_device_key, hash_device_key
from app.db.models import AdminAuditLog, DeviceKey, Organization, OrganizationSettings, RestrictedKeyword, User
from app.db.session import get_db

router = APIRouter(prefix="/api/v1/org", tags=["Organization"])


# --- Shared lookups (also used by the policy sync and evaluation endpoints) ---

def get_org_settings(db: Session, organization_id: str) -> OrganizationSettings:
    """Returns the organization's settings row, creating it with defaults on first use."""
    row = db.query(OrganizationSettings).filter(OrganizationSettings.organization_id == organization_id).first()
    if not row:
        row = OrganizationSettings(organization_id=organization_id)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def get_org_keywords(db: Session, organization_id: str) -> List[str]:
    rows = (
        db.query(RestrictedKeyword.keyword)
        .filter(RestrictedKeyword.organization_id == organization_id)
        .order_by(RestrictedKeyword.keyword.asc())
        .all()
    )
    return [r[0] for r in rows]


def web_filter_settings(row: OrganizationSettings) -> tuple:
    """(category switches, safe_search) with defaults applied; used by the dashboard and the extension sync."""
    categories = effective_web_categories(row.web_categories)
    return categories, effective_safe_search(row.safe_search, categories)


def _settings_out(db: Session, organization_id: str) -> OrgSettingsOut:
    row = get_org_settings(db, organization_id)
    org = db.query(Organization).filter(Organization.id == organization_id).first()
    categories, safe_search = web_filter_settings(row)
    return OrgSettingsOut(
        organization_id=organization_id,
        organization_name=org.name if org else "",
        retention_days=org.retention_days if org else 30,
        store_clean_prompt_text=bool(row.store_clean_prompt_text),
        store_violation_prompt_text=bool(row.store_violation_prompt_text),
        block_unapproved_ai=bool(row.block_unapproved_ai),
        require_device_approval=bool(row.require_device_approval),
        web_categories=categories,
        safe_search=safe_search,
        web_category_catalog=WEB_CATEGORIES,
        web_category_groups=WEB_CATEGORY_GROUPS,
        web_category_presets=WEB_CATEGORY_PRESETS,
        demo_mode=app_settings.DEMO_MODE,
        updated_by=row.updated_by,
        updated_at=row.updated_at,
    )


# --- Legacy device keys (organization-wide "asd_" keys, replaced by per-user activation) ---

def _require_legacy_keys() -> None:
    if not app_settings.LEGACY_DEVICE_KEYS_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="Organization-wide enrollment codes are retired. Invite users and have them activate their browser.",
        )


@router.get("/device-keys", response_model=List[DeviceKeyOut], dependencies=[Depends(_require_legacy_keys)])
def list_device_keys(admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    """Lists enrollment keys. The secret itself is never returned after creation."""
    return (
        db.query(DeviceKey)
        .filter(DeviceKey.organization_id == admin.organization_id)
        .order_by(DeviceKey.active.desc(), DeviceKey.created_at.desc())
        .all()
    )


@router.post(
    "/device-keys", response_model=DeviceKeyCreated, status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(_require_legacy_keys)],
)
def create_device_key(
    payload: DeviceKeyCreate,
    request: Request,
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Creates a new enrollment key. The plaintext key is returned only in this response."""
    raw_key = generate_device_key()
    device = DeviceKey(
        organization_id=admin.organization_id,
        name=payload.name.strip(),
        key_hash=hash_device_key(raw_key),
        key_prefix=raw_key[:10],
        active=True,
        created_by=admin.email,
        created_at=datetime.now(timezone.utc),
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    record_admin_action(
        db, organization_id=admin.organization_id, actor=admin.email, action="device_key.create",
        target_type="device_key", target_id=device.key_prefix, summary=f"Created device key '{device.name}'",
        request=request,
    )
    return DeviceKeyCreated(**DeviceKeyOut.model_validate(device).model_dump(), key=raw_key)


@router.delete("/device-keys/{key_id}", response_model=DeviceKeyOut, dependencies=[Depends(_require_legacy_keys)])
def revoke_device_key(
    key_id: str,
    request: Request,
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Revokes a key. Extensions using it stop syncing and reporting immediately."""
    device = (
        db.query(DeviceKey)
        .filter(DeviceKey.id == key_id, DeviceKey.organization_id == admin.organization_id)
        .first()
    )
    if not device:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device key not found.")
    device.active = False
    db.commit()
    db.refresh(device)
    record_admin_action(
        db, organization_id=admin.organization_id, actor=admin.email, action="device_key.revoke",
        target_type="device_key", target_id=device.key_prefix, summary=f"Revoked device key '{device.name}'",
        request=request,
    )
    return device


# --- Restricted keywords ---

@router.get("/keywords", response_model=List[KeywordOut])
def list_keywords(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return (
        db.query(RestrictedKeyword)
        .filter(RestrictedKeyword.organization_id == current_user.organization_id)
        .order_by(RestrictedKeyword.keyword.asc())
        .all()
    )


@router.post("/keywords", response_model=KeywordOut, status_code=status.HTTP_201_CREATED)
def add_keyword(
    payload: KeywordCreate,
    request: Request,
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    keyword = payload.keyword.strip()
    if len(keyword) < 3:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Keywords must be at least 3 characters.")
    exists = (
        db.query(RestrictedKeyword)
        .filter(
            RestrictedKeyword.organization_id == admin.organization_id,
            func.lower(RestrictedKeyword.keyword) == keyword.lower(),
        )
        .first()
    )
    if exists:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"'{keyword}' is already in the list.")
    row = RestrictedKeyword(
        organization_id=admin.organization_id,
        keyword=keyword,
        created_by=admin.email,
        created_at=datetime.now(timezone.utc),
    )
    db.add(row)
    bump_policy_revision(db, admin.organization_id)
    db.commit()
    db.refresh(row)
    record_admin_action(
        db, organization_id=admin.organization_id, actor=admin.email, action="keyword.add",
        target_type="keyword", target_id=keyword, summary=f"Added confidential keyword '{keyword}'", request=request,
    )
    return row


@router.delete("/keywords/{keyword_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_keyword(
    keyword_id: str,
    request: Request,
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    row = (
        db.query(RestrictedKeyword)
        .filter(RestrictedKeyword.id == keyword_id, RestrictedKeyword.organization_id == admin.organization_id)
        .first()
    )
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Keyword not found.")
    keyword = row.keyword
    db.delete(row)
    bump_policy_revision(db, admin.organization_id)
    db.commit()
    record_admin_action(
        db, organization_id=admin.organization_id, actor=admin.email, action="keyword.delete",
        target_type="keyword", target_id=keyword, summary=f"Removed confidential keyword '{keyword}'", request=request,
    )
    return None


# --- Privacy, retention & shadow-AI settings ---

@router.get("/settings", response_model=OrgSettingsOut)
def read_settings(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _settings_out(db, current_user.organization_id)


@router.patch("/settings", response_model=OrgSettingsOut)
def update_settings(
    payload: OrgSettingsUpdate,
    request: Request,
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    before = _settings_out(db, admin.organization_id).model_dump(
        include={
            "retention_days", "store_clean_prompt_text", "store_violation_prompt_text",
            "block_unapproved_ai", "require_device_approval", "web_categories", "safe_search",
        }
    )
    row = get_org_settings(db, admin.organization_id)
    if payload.web_categories is not None:
        unknown = sorted(set(payload.web_categories) - set(WEB_CATEGORY_IDS))
        if unknown:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"Unknown website categories: {', '.join(unknown)}.")
        merged = effective_web_categories(row.web_categories)
        merged.update(payload.web_categories)
        row.web_categories = json.dumps(merged, sort_keys=True)
    if payload.safe_search is not None:
        row.safe_search = payload.safe_search
    if payload.require_device_approval is not None:
        row.require_device_approval = payload.require_device_approval
    if payload.store_clean_prompt_text is not None:
        row.store_clean_prompt_text = payload.store_clean_prompt_text
    if payload.store_violation_prompt_text is not None:
        row.store_violation_prompt_text = payload.store_violation_prompt_text
    if payload.block_unapproved_ai is not None:
        row.block_unapproved_ai = payload.block_unapproved_ai
    row.updated_by = admin.email
    row.updated_at = datetime.now(timezone.utc)

    if payload.retention_days is not None:
        org = db.query(Organization).filter(Organization.id == admin.organization_id).first()
        if org:
            org.retention_days = payload.retention_days

    bump_policy_revision(db, admin.organization_id)
    db.commit()
    result = _settings_out(db, admin.organization_id)
    after = result.model_dump(include=set(before.keys()))
    changed = [f"{k}: {before[k]} -> {after[k]}" for k in before if before[k] != after[k]]
    if changed:
        record_admin_action(
            db, organization_id=admin.organization_id, actor=admin.email, action="settings.update",
            target_type="settings", summary="Changed " + "; ".join(changed), before=before, after=after, request=request,
        )
    return result


# --- Administrative audit log ---

@router.get("/audit-log", response_model=AuditLogPage)
def read_audit_log(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    action: Optional[str] = Query(None, description="Prefix filter, e.g. 'policy' or 'login.failed'"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Administrative changes and sign-in attempts for the caller's organization, newest first."""
    query = db.query(AdminAuditLog).filter(AdminAuditLog.organization_id == current_user.organization_id)
    if action:
        query = query.filter(AdminAuditLog.action.like(f"{action}%"))
    total = query.count()
    items = (
        query.order_by(AdminAuditLog.occurred_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return AuditLogPage(total=total, items=items)
