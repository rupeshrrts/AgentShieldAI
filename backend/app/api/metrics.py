"""Metrics & Security Analytics API Endpoints.

Calculates dashboard KPI metrics, violation breakdowns, severity distributions,
and risk summaries grouped by company/organization for the administrative overview.
"""

from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import List
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.api.schemas import CompanyBreakdownItem, MetricsSummaryResponse, SecurityEventOut
from app.db.models import Organization, Policy, SecurityEvent, User
from app.db.session import get_db

router = APIRouter(prefix="/api/v1/metrics", tags=["Metrics"])


@router.get("/summary", response_model=MetricsSummaryResponse)
def get_metrics_summary(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Computes aggregated governance metrics for the dashboard charts and stat cards."""
    # Tenant isolation: operators only ever see their own organization (no customer role sees others)
    org_query = db.query(Organization).filter(Organization.id == current_user.organization_id)
    query = db.query(SecurityEvent).filter(SecurityEvent.organization_id == current_user.organization_id)
    policy_query = db.query(Policy).filter(Policy.enabled == True, Policy.organization_id == current_user.organization_id)

    all_orgs = org_query.all()
    org_map = {o.id: o.name for o in all_orgs}

    events = query.order_by(SecurityEvent.occurred_at.desc()).all()

    total_events = len(events)
    blocked_count = sum(1 for e in events if e.action == "BLOCK")
    warned_count = sum(1 for e in events if e.action == "WARN")
    redacted_count = sum(1 for e in events if e.action == "REDACT")
    allowed_count = sum(1 for e in events if e.action == "ALLOW")
    monitored_count = sum(1 for e in events if e.action == "MONITOR")
    since_24h = datetime.now(timezone.utc) - timedelta(hours=24)
    events_last_24h = sum(1 for e in events if (e.occurred_at if e.occurred_at.tzinfo else e.occurred_at.replace(tzinfo=timezone.utc)) >= since_24h)

    active_policies_count = policy_query.count()

    # Calculate distributions for chart visualization
    category_distribution = dict(Counter(e.category for e in events))
    severity_distribution = dict(Counter(e.severity for e in events))
    sites = Counter((e.site or "unknown") for e in events).most_common()
    site_distribution = dict(sites[:8])
    if len(sites) > 8:
        site_distribution["Other"] = sum(n for _, n in sites[8:])

    # Last 14 UTC days, oldest first, split by action
    today = datetime.now(timezone.utc).date()
    days = [(today - timedelta(days=13 - i)).isoformat() for i in range(14)]
    by_day = {d: {"day": d, "blocked": 0, "warned": 0, "redacted": 0, "other": 0} for d in days}
    for e in events:
        occurred = e.occurred_at if e.occurred_at.tzinfo else e.occurred_at.replace(tzinfo=timezone.utc)
        row = by_day.get(occurred.date().isoformat())
        if row is not None:
            key = {"BLOCK": "blocked", "WARN": "warned", "REDACT": "redacted"}.get(e.action, "other")
            row[key] += 1
    daily_events = [by_day[d] for d in days]

    # Prepare recent 10 events for the quick view table
    recent_events = []
    for e in events[:10]:
        event_dict = SecurityEventOut.model_validate(e)
        event_dict.company_name = org_map.get(e.organization_id)
        recent_events.append(event_dict)

    # Group violations by organization to highlight top risk areas
    company_breakdown: List[CompanyBreakdownItem] = []
    events_by_org = {}
    for e in events:
        events_by_org.setdefault(e.organization_id, []).append(e)

    for org in all_orgs:
        org_events = events_by_org.get(org.id, [])
        b_count = sum(1 for e in org_events if e.action == "BLOCK")
        w_count = sum(1 for e in org_events if e.action == "WARN")
        r_count = sum(1 for e in org_events if e.action == "REDACT")
        a_count = sum(1 for e in org_events if e.action == "ALLOW")
        bad_reqs = b_count + w_count + r_count

        # Identify which rule was violated most often in this organization
        rules = [e.rule_id for e in org_events if e.action in ("BLOCK", "WARN", "REDACT")]
        top_rule = Counter(rules).most_common(1)[0][0] if rules else None
        last_time = org_events[0].occurred_at if org_events else None

        company_breakdown.append(
            CompanyBreakdownItem(
                organization_id=org.id,
                company_name=org.name,
                total_events=len(org_events),
                total_bad_requests=bad_reqs,
                blocked_count=b_count,
                warned_count=w_count,
                redacted_count=r_count,
                allowed_count=a_count,
                top_violation_rule=top_rule,
                latest_violation_at=last_time,
            )
        )

    # Sort organizations by number of intercepted violations descending
    company_breakdown.sort(key=lambda x: x.total_bad_requests, reverse=True)

    return MetricsSummaryResponse(
        total_events=total_events,
        blocked_count=blocked_count,
        warned_count=warned_count,
        redacted_count=redacted_count,
        allowed_count=allowed_count,
        monitored_count=monitored_count,
        events_last_24h=events_last_24h,
        active_policies_count=active_policies_count,
        category_distribution=category_distribution,
        severity_distribution=severity_distribution,
        site_distribution=site_distribution,
        daily_events=daily_events,
        recent_events=recent_events,
        company_breakdown=company_breakdown,
    )


@router.get("/companies", response_model=List[CompanyBreakdownItem])
def get_company_breakdown(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Returns organizational breakdown of security events and violations."""
    summary = get_metrics_summary(current_user=current_user, db=db)
    return summary.company_breakdown
