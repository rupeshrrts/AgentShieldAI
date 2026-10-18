"""Domain Traffic Control API Endpoints.

Allows organizations to define blocked vs. allowed web domains:
- BLOCKED: Suspicious file converters, shadow AI, pastebins, or exfiltration targets.
- ALLOWED: Approved enterprise AI services (ChatGPT Enterprise, Claude, Gemini).
"""

from datetime import datetime, timezone
from typing import Optional
import re
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.api.deps import Principal, get_current_admin, get_principal
from app.api.schemas import (
    DomainRuleCreate,
    DomainRuleListResponse,
    DomainRuleOut,
    DomainRuleUpdate,
)
from app.core.audit import record_admin_action, snapshot
from app.db.models import DomainRule, User
from app.db.session import get_db

router = APIRouter(prefix="/api/v1/domains", tags=["Domains"])


def normalize_domain(domain_str: str) -> str:
    """Cleans a raw URL or domain string into a canonical lowercase hostname.

    Example inputs:
      'https://www.ilovepdf.com/compress' -> 'www.ilovepdf.com'
      'Pastebin.com:443'                  -> 'pastebin.com'
    """
    domain_clean = domain_str.strip().lower()
    if "://" in domain_clean:
        domain_clean = domain_clean.split("://", 1)[1]
    if "/" in domain_clean:
        domain_clean = domain_clean.split("/", 1)[0]
    if ":" in domain_clean:
        domain_clean = domain_clean.split(":", 1)[0]
    domain_clean = domain_clean.strip().strip(".")
    if domain_clean.startswith("*."):
        domain_clean = domain_clean[2:]  # Subdomains are always included
    if not _HOSTNAME.match(domain_clean):
        return ""
    return domain_clean


# A hostname with at least one dot (rules apply to the domain and all its subdomains)
_HOSTNAME = re.compile(r"^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$")
_DOMAIN_FIELDS = ["domain", "action", "category", "description", "enabled"]


@router.get("", response_model=DomainRuleListResponse)
def list_domains(
    action: Optional[str] = Query(None, pattern="^(BLOCK|ALLOW)$", description="Filter by action type (BLOCK or ALLOW)"),
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    """Returns all blocked and allowed domains for the caller's organization (dashboard or device key)."""
    query = db.query(DomainRule).filter(DomainRule.organization_id == principal.organization_id)
    if action:
        query = query.filter(DomainRule.action == action.upper())

    domains = query.order_by(DomainRule.action.asc(), DomainRule.domain.asc()).all()
    return DomainRuleListResponse(
        organization_id=principal.organization_id,
        total=len(domains),
        domains=domains,
    )


@router.post("", response_model=DomainRuleOut, status_code=status.HTTP_201_CREATED)
def create_domain_rule(
    payload: DomainRuleCreate,
    request: Request,
    admin_user: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Adds a new domain rule. Normalizes the domain string before persisting."""
    norm_domain = normalize_domain(payload.domain)
    if not norm_domain:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid domain format. Provide a valid hostname such as 'example.com'.",
        )

    # Avoid duplicate rules for the same domain within an organization
    existing = (
        db.query(DomainRule)
        .filter(
            DomainRule.organization_id == admin_user.organization_id,
            DomainRule.domain == norm_domain,
        )
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"A domain rule for '{norm_domain}' already exists in your organization.",
        )

    rule = DomainRule(
        organization_id=admin_user.organization_id,
        domain=norm_domain,
        action=payload.action.upper(),
        category=payload.category or ("Sanctioned GenAI" if payload.action.upper() == "ALLOW" else "Restricted DLP Domain"),
        description=payload.description or f"Traffic policy: {payload.action.upper()} {norm_domain}",
        enabled=payload.enabled,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    record_admin_action(
        db, organization_id=admin_user.organization_id, actor=admin_user.email, action="domain.create",
        target_type="domain", target_id=rule.domain, summary=f"{rule.action} rule added for {rule.domain}",
        after=snapshot(rule, _DOMAIN_FIELDS), request=request,
    )
    return rule


@router.patch("/{domain_id}", response_model=DomainRuleOut)
def update_domain_rule(
    domain_id: str,
    payload: DomainRuleUpdate,
    request: Request,
    admin_user: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Updates an existing domain rule (toggle status, change action, or edit notes)."""
    rule = (
        db.query(DomainRule)
        .filter(
            DomainRule.id == domain_id,
            DomainRule.organization_id == admin_user.organization_id,
        )
        .first()
    )
    if not rule:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Domain rule with ID '{domain_id}' not found.",
        )

    before = snapshot(rule, _DOMAIN_FIELDS)
    if payload.action is not None:
        rule.action = payload.action.upper()
    if payload.category is not None:
        rule.category = payload.category
    if payload.description is not None:
        rule.description = payload.description
    if payload.enabled is not None:
        rule.enabled = payload.enabled

    rule.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(rule)
    record_admin_action(
        db, organization_id=admin_user.organization_id, actor=admin_user.email, action="domain.update",
        target_type="domain", target_id=rule.domain, summary=f"Updated rule for {rule.domain}",
        before=before, after=snapshot(rule, _DOMAIN_FIELDS), request=request,
    )
    return rule


@router.delete("/{domain_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_domain_rule(
    domain_id: str,
    request: Request,
    admin_user: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Removes a domain rule from the organization."""
    rule = (
        db.query(DomainRule)
        .filter(
            DomainRule.id == domain_id,
            DomainRule.organization_id == admin_user.organization_id,
        )
        .first()
    )
    if not rule:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Domain rule with ID '{domain_id}' not found.",
        )

    before = snapshot(rule, _DOMAIN_FIELDS)
    db.delete(rule)
    db.commit()
    record_admin_action(
        db, organization_id=admin_user.organization_id, actor=admin_user.email, action="domain.delete",
        target_type="domain", target_id=before["domain"], summary=f"Removed rule for {before['domain']}",
        before=before, request=request,
    )
    return None
