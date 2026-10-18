"""Security Events & Audit Ingestion API Endpoints.

Handles:
1. Ingesting events reported by the browser extension (blocked prompts, warnings, redactions, domain blocks).
2. Querying paginated audit events with rich filtering (by severity, action, time frame, department, or free-text search).
"""

import csv
import io
import time
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import case, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import Principal, employee_id_for, enforce_device_rate_limit, get_current_admin, get_current_user, get_principal
from app.api.organization import get_org_settings
from app.api.schemas import (
    EventsPaginatedResponse,
    SecurityEventCreate,
    SecurityEventOut,
    UserActionRequest,
    UserActionResponse,
    UserRiskSummary,
)
from app.core.audit import record_admin_action
from app.core.privacy import prepare_prompt_for_storage
from app.core.usage import is_prompt_check, record_check
from app.db.models import Endpoint, Organization, SecurityEvent, User, UserGovernance
from app.db.session import get_db

router = APIRouter(prefix="/api/v1/events", tags=["Events"])

# Known AI and file-sharing hosts, used to label events in the dashboard
_APPLICATION_NAMES = {
    "chatgpt.com": "ChatGPT",
    "openai.com": "ChatGPT",
    "claude.ai": "Claude",
    "gemini.google.com": "Gemini",
    "copilot.microsoft.com": "Copilot",
    "perplexity.ai": "Perplexity",
}


def _application_for_site(site: str) -> str:
    host = (site or "").lower()
    for domain, name in _APPLICATION_NAMES.items():
        if host == domain or host.endswith("." + domain):
            return name
    return host or "Unknown"


# --- Retention: delete events older than each organization's retention period ---
_RETENTION_INTERVAL_SECONDS = 3600
_last_retention_run = 0.0


def purge_expired_events(db: Session) -> int:
    """Deletes events older than each organization's retention_days. Returns rows deleted."""
    deleted = 0
    now = datetime.now(timezone.utc)
    for org in db.query(Organization).all():
        days = org.retention_days or 30
        cutoff = now - timedelta(days=days)
        deleted += (
            db.query(SecurityEvent)
            .filter(SecurityEvent.organization_id == org.id, SecurityEvent.occurred_at < cutoff)
            .delete(synchronize_session=False)
        )
    db.commit()
    return deleted


def _maybe_purge(db: Session) -> None:
    global _last_retention_run
    if time.monotonic() - _last_retention_run < _RETENTION_INTERVAL_SECONDS:
        return
    _last_retention_run = time.monotonic()
    try:
        purge_expired_events(db)
    except Exception:
        db.rollback()


def _event_out(event: SecurityEvent) -> SecurityEventOut:
    out = SecurityEventOut.model_validate(event)
    out.company_name = event.organization.name if event.organization else None
    return out


@router.post("", response_model=SecurityEventOut, status_code=status.HTTP_201_CREATED)
def ingest_event(
    payload: SecurityEventCreate,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    """Ingests a security event dispatched from a browser extension.

    The organization is taken from the caller's device key or login, never from the
    payload. Secrets are masked and prompt text is kept or dropped according to the
    organization's privacy settings before anything is stored.
    """
    target_org_id = principal.organization_id
    effective_user_id = employee_id_for(principal, payload.user_id)
    enforce_device_rate_limit(principal, effective_user_id)

    org_settings = get_org_settings(db, target_org_id)
    is_clean = payload.action == "ALLOW" and payload.category == "PROMPT_LOG"
    store_text = (
        bool(org_settings.store_clean_prompt_text) if is_clean else bool(org_settings.store_violation_prompt_text)
    )
    stored_prompt, stored_preview = prepare_prompt_for_storage(payload.prompt or payload.prompt_preview, store_text)

    # A retried or replayed extension event (same client_event_id) is stored and metered once
    client_event_id = (payload.client_event_id or "").strip() or None
    if client_event_id:
        replay = db.query(SecurityEvent).filter(SecurityEvent.organization_id == target_org_id,
                                                SecurityEvent.client_event_id == client_event_id).first()
        if replay:
            return _event_out(replay)

    # Older extensions send no event id: ignore identical event submissions within 3 seconds
    recent_threshold = datetime.now(timezone.utc) - timedelta(seconds=3)
    existing_duplicate = None if client_event_id else (
        db.query(SecurityEvent)
        .filter(
            SecurityEvent.organization_id == target_org_id,
            SecurityEvent.user_id == effective_user_id,
            SecurityEvent.rule_id == payload.rule_id,
            SecurityEvent.action == payload.action,
            SecurityEvent.prompt_preview == stored_preview,
            SecurityEvent.occurred_at >= recent_threshold,
        )
        .order_by(SecurityEvent.occurred_at.desc())
        .first()
    )
    if existing_duplicate:
        return _event_out(existing_duplicate)

    event = SecurityEvent(
        organization_id=target_org_id,
        user_id=effective_user_id,
        occurred_at=datetime.now(timezone.utc),
        site=payload.site,
        rule_id=payload.rule_id,
        category=payload.category,
        severity=payload.severity,
        action=payload.action,
        outcome=payload.outcome,
        extension_version=payload.extension_version or "1.0.0",
        policy_version=payload.policy_version or 1,
        department=payload.department or "Unassigned",
        application=payload.application or _application_for_site(payload.site),
        prompt=stored_prompt,
        prompt_preview=stored_preview,
        dlp_engine=payload.dlp_engine or "-",
        location=payload.location or "-",
        justification=(payload.justification or "").strip() or None,
        client_event_id=client_event_id,
    )
    db.add(event)
    try:
        db.commit()
    except IntegrityError:  # the same client_event_id arrived concurrently
        db.rollback()
        replay = db.query(SecurityEvent).filter(SecurityEvent.organization_id == target_org_id,
                                                SecurityEvent.client_event_id == client_event_id).first()
        if replay:
            return _event_out(replay)
        raise
    db.refresh(event)

    # Metering: only prompt checks reported by an activated browser are billable usage
    if principal.device is not None and is_prompt_check(payload.rule_id, payload.outcome):
        record_check(db, target_org_id, effective_user_id, payload.action)

    _maybe_purge(db)
    return _event_out(event)


class EventFilters:
    """Query parameters shared by the event list and the CSV export."""

    def __init__(
        self,
        organization_id: Optional[str] = Query(None, description="Superadmin filter for specific tenant"),
        user_id: Optional[str] = Query(None, description="Filter for specific employee user ID"),
        severity: Optional[str] = Query(None, description="Filter: LOW, MEDIUM, HIGH, CRITICAL"),
        action: Optional[str] = Query(None, description="Filter: ALLOW, MONITOR, WARN, BLOCK, REDACT"),
        access_type: Optional[str] = Query(None, description="Alias for action filter"),
        department: Optional[str] = Query(None, description="Filter by employee department"),
        application: Optional[str] = Query(None, description="Filter by AI app (e.g. ChatGPT)"),
        dlp_engine: Optional[str] = Query(None, description="Filter by detection engine"),
        site: Optional[str] = Query(None, description="Filter by hostname"),
        rule_id: Optional[str] = Query(None, description="Filter by specific rule ID"),
        search: Optional[str] = Query(None, description="Free text search across prompt, user ID, and metadata"),
        time_frame: Optional[str] = Query(None, description="Time window: today, yesterday, 7d, 30d, or all"),
        since: Optional[datetime] = Query(None, description="Only events at or after this ISO timestamp"),
        sort_by: Optional[str] = Query(None, description="Sort column (date, user, severity, action)"),
        sort_order: Optional[str] = Query("desc", description="Sort direction: 'asc' or 'desc'"),
    ):
        self.organization_id = organization_id
        self.user_id = user_id
        self.severity = severity
        self.action = action
        self.access_type = access_type
        self.department = department
        self.application = application
        self.dlp_engine = dlp_engine
        self.site = site
        self.rule_id = rule_id
        self.search = search
        self.time_frame = time_frame
        self.since = since
        self.sort_by = sort_by
        self.sort_order = sort_order


def _events_query(db: Session, current_user: User, f: EventFilters):
    """Builds the filtered, sorted, tenant-scoped event query."""
    organization_id, user_id, severity, action, access_type = f.organization_id, f.user_id, f.severity, f.action, f.access_type
    department, application, dlp_engine, site, rule_id = f.department, f.application, f.dlp_engine, f.site, f.rule_id
    search, time_frame, sort_by, sort_order = f.search, f.time_frame, f.sort_by, f.sort_order

    # Always the caller's own company; an organization_id in the request is ignored
    query = db.query(SecurityEvent).filter(SecurityEvent.organization_id == current_user.organization_id)

    # 1. Exact / category filters
    if user_id and user_id.upper() != "ALL":
        query = query.filter(SecurityEvent.user_id == user_id.strip())
    if severity and severity.upper() != "ALL":
        query = query.filter(SecurityEvent.severity == severity.upper())
    if action and action.upper() != "ALL":
        query = query.filter(SecurityEvent.action == action.upper())
    if access_type and access_type.upper() != "ALL":
        query = query.filter(SecurityEvent.action == access_type.upper())
    if site and site.upper() != "ALL":
        query = query.filter(SecurityEvent.site.ilike(f"%{site}%"))
    if department and department.upper() != "ALL":
        query = query.filter(SecurityEvent.department.ilike(f"%{department}%"))
    if application and application.upper() != "ALL":
        query = query.filter(SecurityEvent.application.ilike(f"%{application}%"))
    if dlp_engine and dlp_engine.upper() != "ALL":
        query = query.filter(SecurityEvent.dlp_engine.ilike(f"%{dlp_engine}%"))
    if rule_id and rule_id.upper() != "ALL":
        query = query.filter(SecurityEvent.rule_id == rule_id)

    # 2. Multi-column text search
    if search and search.strip():
        term = f"%{search.strip()}%"
        query = query.filter(
            or_(
                SecurityEvent.user_id.ilike(term),
                SecurityEvent.prompt_preview.ilike(term),
                SecurityEvent.department.ilike(term),
                SecurityEvent.application.ilike(term),
                SecurityEvent.dlp_engine.ilike(term),
                SecurityEvent.location.ilike(term),
                SecurityEvent.site.ilike(term),
                SecurityEvent.rule_id.ilike(term),
            )
        )

    # 3. Relative time frame filter
    if time_frame and time_frame.lower().strip() != "all":
        now = datetime.now(timezone.utc)
        tf = time_frame.lower().strip()
        if tf == "today":
            start_of_today = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
            query = query.filter(SecurityEvent.occurred_at >= start_of_today)
        elif tf == "yesterday":
            start_of_today = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
            start_of_yesterday = start_of_today - timedelta(days=1)
            query = query.filter(
                SecurityEvent.occurred_at >= start_of_yesterday,
                SecurityEvent.occurred_at < start_of_today,
            )
        elif tf in ("7d", "last 7 days", "week"):
            query = query.filter(SecurityEvent.occurred_at >= now - timedelta(days=7))
        elif tf in ("30d", "last 30 days", "month"):
            query = query.filter(SecurityEvent.occurred_at >= now - timedelta(days=30))
    if f.since is not None:
        since = f.since if f.since.tzinfo else f.since.replace(tzinfo=timezone.utc)
        query = query.filter(SecurityEvent.occurred_at >= since)

    # 4. Sorting
    sort_column_map = {
        "user": SecurityEvent.user_id,
        "department": SecurityEvent.department,
        "application": SecurityEvent.application,
        "prompt": SecurityEvent.prompt_preview,
        "dlp_engine": SecurityEvent.dlp_engine,
        "location": SecurityEvent.location,
        "date": SecurityEvent.occurred_at,
        "occurred_at": SecurityEvent.occurred_at,
        "severity": SecurityEvent.severity,
        "action": SecurityEvent.action,
    }
    sort_col = sort_column_map.get(sort_by.lower() if sort_by else "date", SecurityEvent.occurred_at)
    if sort_order and sort_order.lower() == "asc":
        query = query.order_by(sort_col.asc())
    else:
        query = query.order_by(sort_col.desc())

    return query


@router.get("", response_model=EventsPaginatedResponse)
def list_events(
    page: int = Query(1, ge=1, description="Page number starting at 1"),
    page_size: int = Query(50, ge=1, le=100, description="Items per page (max 100)"),
    filters: EventFilters = Depends(),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Returns a filtered, paginated list of security events for the admin audit table."""
    query = _events_query(db, current_user, filters)
    total = query.count()
    items = query.offset((page - 1) * page_size).limit(page_size).all()
    return EventsPaginatedResponse(
        total=total,
        page=page,
        page_size=page_size,
        items=[_event_out(e) for e in items],
    )


_CSV_COLUMNS = [
    "occurred_at", "user_id", "site", "application", "rule_id", "category", "severity",
    "action", "outcome", "justification", "prompt_preview", "extension_version", "policy_version",
]
_CSV_MAX_ROWS = 50000


def _csv_safe(value) -> str:
    """Stringifies a value and neutralizes spreadsheet formula injection."""
    text = "" if value is None else (value.isoformat() if isinstance(value, datetime) else str(value))
    if text[:1] in ("=", "+", "-", "@", "\t", "\r"):
        text = "'" + text
    return text


@router.get("/export.csv")
def export_events_csv(
    request: Request,
    filters: EventFilters = Depends(),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Downloads the filtered events as CSV (up to 50,000 rows). The export itself is audit-logged."""
    # Rows are loaded before streaming starts, because the DB session closes when the endpoint returns
    events = _events_query(db, current_user, filters).limit(_CSV_MAX_ROWS).all()

    def rows():
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(_CSV_COLUMNS)
        yield buffer.getvalue()
        for event in events:
            buffer.seek(0)
            buffer.truncate(0)
            writer.writerow([_csv_safe(getattr(event, c, None)) for c in _CSV_COLUMNS])
            yield buffer.getvalue()

    record_admin_action(
        db, organization_id=current_user.organization_id, actor=current_user.email, action="events.export",
        target_type="events", summary="Exported security events to CSV", request=request,
    )
    filename = f"agentshield-events-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')}.csv"
    return StreamingResponse(
        rows(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/users/summary", response_model=List[UserRiskSummary])
def list_users_summary(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Returns prompt statistics and risk profiles for every employee.

    Includes employees whose browser has checked in (heartbeat) but who have not sent
    a prompt yet. Website blocks are counted separately, not as prompts.
    """
    target_org = current_user.organization_id
    is_site_event = SecurityEvent.rule_id.like("dlp.%")
    is_prompt = ~is_site_event
    flagged_actions = ("BLOCK", "WARN", "REDACT", "MONITOR")

    # 1. Fetch user prompt stats aggregated from SecurityEvent
    user_rows = (
        db.query(
            SecurityEvent.user_id,
            func.max(SecurityEvent.department).label("department"),
            func.sum(case((is_prompt, 1), else_=0)).label("total"),
            func.sum(case((is_prompt & (SecurityEvent.action == "ALLOW"), 1), else_=0)).label("good"),
            func.sum(case((is_prompt & SecurityEvent.action.in_(flagged_actions), 1), else_=0)).label("bad"),
            func.sum(case((is_prompt & (SecurityEvent.action == "BLOCK"), 1), else_=0)).label("blocked"),
            func.sum(case((SecurityEvent.action == "WARN", 1), else_=0)).label("warned"),
            func.sum(case((SecurityEvent.action == "REDACT", 1), else_=0)).label("redacted"),
            func.sum(case((SecurityEvent.action == "MONITOR", 1), else_=0)).label("monitored"),
            func.sum(case((is_site_event, 1), else_=0)).label("blocked_sites"),
            func.max(SecurityEvent.occurred_at).label("latest_activity"),
        )
        .filter(SecurityEvent.organization_id == target_org)
        .group_by(SecurityEvent.user_id)
        .all()
    )

    # Employees whose browser is enrolled but who have no events yet
    seen = {r.user_id for r in user_rows}
    quiet_users = (
        db.query(Endpoint.user_id, func.max(Endpoint.last_seen_at))
        .filter(Endpoint.organization_id == target_org, Endpoint.user_id.isnot(None))
        .group_by(Endpoint.user_id)
        .all()
    )

    # 2. Fetch existing governance status
    gov_records = {
        g.user_id: g
        for g in db.query(UserGovernance).filter(UserGovernance.organization_id == target_org).all()
    }

    results: List[UserRiskSummary] = []
    for uid, last_seen in quiet_users:
        if uid in seen:
            continue
        gov = gov_records.get(uid)
        results.append(UserRiskSummary(
            user_id=uid, total_prompts=0, good_prompts=0, bad_prompts=0, blocked_count=0,
            warned_count=0, redacted_count=0, status=gov.status if gov else "ACTIVE",
            risk_level="CRITICAL" if gov and gov.status == "SUSPENDED" else "HIGH" if gov and gov.status == "RESTRICTED" else "LOW",
            notes=gov.notes if gov else None, action_taken_by=gov.action_taken_by if gov else None,
            latest_activity=last_seen,
        ))

    for r in user_rows:
        uid = r.user_id or "unknown"
        gov = gov_records.get(uid)

        status = gov.status if gov else "ACTIVE"
        notes = gov.notes if gov else None
        action_by = gov.action_taken_by if gov else None

        total = int(r.total or 0)
        good = int(r.good or 0)
        bad = int(r.bad or 0)
        blocked = int(r.blocked or 0)
        warned = int(r.warned or 0)
        redacted = int(r.redacted or 0)

        # Compute Risk Level
        if status == "SUSPENDED":
            risk_level = "CRITICAL"
        elif status == "RESTRICTED":
            risk_level = "HIGH"
        elif blocked >= 3 or bad >= 5:
            risk_level = "CRITICAL"
        elif blocked >= 1 or bad >= 2:
            risk_level = "HIGH"
        elif bad > 0:
            risk_level = "MEDIUM"
        else:
            risk_level = "LOW"

        results.append(
            UserRiskSummary(
                user_id=uid,
                department=r.department if r.department and r.department != "Unassigned" else None,
                total_prompts=total,
                good_prompts=good,
                bad_prompts=bad,
                blocked_count=blocked,
                warned_count=warned,
                redacted_count=redacted,
                monitored_count=int(r.monitored or 0),
                blocked_sites_count=int(r.blocked_sites or 0),
                status=status,
                risk_level=risk_level,
                notes=notes,
                action_taken_by=action_by,
                latest_activity=r.latest_activity,
            )
        )

    # Sort by risk priority: CRITICAL > HIGH > MEDIUM > LOW, then by total bad prompts
    risk_weight = {"CRITICAL": 4, "HIGH": 3, "MEDIUM": 2, "LOW": 1}
    results.sort(key=lambda x: (risk_weight.get(x.risk_level, 0), x.bad_prompts, x.total_prompts), reverse=True)
    return results


@router.post("/users/{user_id}/action", response_model=UserActionResponse)
def take_user_action(
    user_id: str,
    payload: UserActionRequest,
    request: Request,
    current_user: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Applies administrative governance action (SUSPEND, RESTRICT, WARN, RESTORE) against an employee. Admins only."""
    target_org = current_user.organization_id
    gov = db.query(UserGovernance).filter(
        UserGovernance.organization_id == target_org,
        UserGovernance.user_id == user_id,
    ).first()
    previous_status = gov.status if gov else "ACTIVE"

    status_map = {
        "SUSPEND": "SUSPENDED",
        "RESTRICT": "RESTRICTED",
        "WARN": "WARNED",
        "RESTORE": "ACTIVE",
    }
    new_status = status_map.get(payload.action, "ACTIVE")

    if not gov:
        gov = UserGovernance(
            organization_id=target_org,
            user_id=user_id,
            status=new_status,
            notes=payload.notes,
            action_taken_by=current_user.email,
        )
        db.add(gov)
    else:
        gov.status = new_status
        gov.notes = payload.notes or gov.notes
        gov.action_taken_by = current_user.email
        gov.updated_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(gov)
    record_admin_action(
        db, organization_id=target_org, actor=current_user.email, action=f"employee.{payload.action.lower()}",
        target_type="employee", target_id=user_id,
        summary=f"Employee {user_id}: {previous_status} -> {new_status}" + (f" ({payload.notes})" if payload.notes else ""),
        before={"status": previous_status}, after={"status": new_status}, request=request,
    )
    return UserActionResponse(
        user_id=gov.user_id,
        status=gov.status,
        notes=gov.notes,
        action_taken_by=gov.action_taken_by,
        updated_at=gov.updated_at,
    )


@router.get("/users/{user_id}/status")
def get_user_status(
    user_id: str,
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    """Lets the extension or dashboard check whether an employee is suspended or restricted.

    An activated device can only ask about its own account.
    """
    if principal.device is not None and principal.user is not None:
        user_id = principal.user.email
    gov = db.query(UserGovernance).filter(
        UserGovernance.organization_id == principal.organization_id,
        UserGovernance.user_id == user_id,
    ).first()

    if not gov:
        return {"user_id": user_id, "status": "ACTIVE", "notes": None}
    return {
        "user_id": user_id,
        "status": gov.status,
        "notes": gov.notes,
        "updated_at": gov.updated_at,
    }
