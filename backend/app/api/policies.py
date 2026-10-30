"""Policy Management API Endpoints.

Provides administrative operations for organization security policies, the
extension sync payload, one-click presets, and a dry-run `/evaluate` endpoint
for testing prompt inspection in the sandbox.

Policies can only reference rule IDs from the detection catalog
(app/core/catalog.py), because no other rule IDs are ever produced by the detectors.
"""

from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.api.deps import Principal, get_current_admin, get_current_user, get_principal
from app.api.organization import get_org_keywords, get_org_settings, web_filter_settings
from app.api.schemas import (
    ApplyPresetRequest,
    EvaluatePromptRequest,
    EvaluatePromptResponse,
    ExtensionSettings,
    PolicyCreate,
    PolicyListResponse,
    PolicyOut,
    PolicyUpdate,
    RuleCatalogItem,
)
from app.core.audit import record_admin_action, snapshot
from app.core.catalog import KNOWN_AI_DOMAINS, PRESETS, RULE_CATALOG, RULE_IDS
from app.core.entitlements import current_entitlement
from app.core.policy_revision import bump_policy_revision, current_policy_revision
from app.db.models import Organization, Policy, User
from app.db.seed import ensure_catalog_policies
from app.db.session import get_db
from app.detection.detector import DetectorEngine
from app.policies.evaluator import PolicyEvaluator, PolicyRule

router = APIRouter(prefix="/api/v1/policies", tags=["Policies"])

_POLICY_FIELDS = ["name", "rule_id", "site_scope", "action", "severity", "enabled", "version"]


@router.get("", response_model=PolicyListResponse)
def list_policies(
    site: Optional[str] = Query(None, description="Optional filter by website scope (e.g., chatgpt.com)"),
    principal: Principal = Depends(get_principal),
    db: Session = Depends(get_db),
):
    """Retrieves policies, keywords and settings for the caller's organization.

    This is the single sync call the browser extension makes, authenticated with its device key.
    """
    org_id = principal.organization_id
    # Every catalog rule gets a row, so each one can be switched on or off in the dashboard. A rule added
    # to the catalog after this organization was created gets its row here.
    if ensure_catalog_policies(db, org_id):
        bump_policy_revision(db, org_id)
        db.commit()

    query = db.query(Policy).filter(Policy.organization_id == org_id)
    if site:
        query = query.filter((Policy.site_scope == "*") | (Policy.site_scope == site))

    policies = query.order_by(Policy.created_at.desc()).all()

    # Track policy version so the browser extension can verify if its local cache is up to date
    max_version = max((p.version for p in policies), default=1)

    org = db.query(Organization).filter(Organization.id == org_id).first()
    org_settings = get_org_settings(db, org_id)
    web_categories, safe_search = web_filter_settings(org_settings)

    return PolicyListResponse(
        organization_id=org_id,
        organization_name=org.name if org else None,
        policy_version=max_version,
        policy_revision=current_policy_revision(db, org_id),
        last_synced_at=datetime.now(timezone.utc),
        policies=policies,
        keywords=get_org_keywords(db, org_id),
        settings=ExtensionSettings(
            store_clean_prompt_text=bool(org_settings.store_clean_prompt_text),
            store_violation_prompt_text=bool(org_settings.store_violation_prompt_text),
            block_unapproved_ai=bool(org_settings.block_unapproved_ai),
            web_categories=web_categories,
            safe_search=safe_search,
        ),
        ai_domains=KNOWN_AI_DOMAINS,
        entitlement=current_entitlement(db, org_id).as_dict(),
    )


@router.get("/revision")
def policy_revision(principal: Principal = Depends(get_principal), db: Session = Depends(get_db)):
    """Cheap change check for browsers: they download the full sync only when the revision differs from theirs."""
    return {"revision": current_policy_revision(db, principal.organization_id)}


@router.get("/catalog", response_model=List[RuleCatalogItem])
def rule_catalog(current_user: User = Depends(get_current_user)):
    """Lists the rules the detectors support, with their recommended actions."""
    return RULE_CATALOG


@router.post("", response_model=PolicyOut, status_code=status.HTTP_201_CREATED)
def create_policy(
    payload: PolicyCreate,
    request: Request,
    admin_user: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Creates a policy for a catalog rule. Requires administrator privileges."""
    if payload.rule_id not in RULE_IDS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown rule '{payload.rule_id}'. Choose one of: {', '.join(sorted(RULE_IDS))}.",
        )
    existing = (
        db.query(Policy)
        .filter(
            Policy.organization_id == admin_user.organization_id,
            Policy.rule_id == payload.rule_id,
        )
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"A policy with rule ID '{payload.rule_id}' already exists in your organization.",
        )

    category = next(r["category"] for r in RULE_CATALOG if r["rule_id"] == payload.rule_id)
    policy = Policy(
        organization_id=admin_user.organization_id,
        name=payload.name,
        rule_id=payload.rule_id,
        category=category,
        site_scope=payload.site_scope or "*",
        action=payload.action,
        severity=payload.severity,
        enabled=payload.enabled,
        version=1,
        updated_by=admin_user.email,
        updated_at=datetime.now(timezone.utc),
    )
    db.add(policy)
    bump_policy_revision(db, admin_user.organization_id)
    db.commit()
    db.refresh(policy)
    record_admin_action(
        db, organization_id=admin_user.organization_id, actor=admin_user.email, action="policy.create",
        target_type="policy", target_id=policy.rule_id, summary=f"Created policy '{policy.name}' ({policy.action})",
        after=snapshot(policy, _POLICY_FIELDS), request=request,
    )
    return policy


@router.patch("/{policy_id}", response_model=PolicyOut)
def update_policy(
    policy_id: str,
    payload: PolicyUpdate,
    request: Request,
    admin_user: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Updates an existing policy. Automatically increments policy version to trigger client sync."""
    policy = (
        db.query(Policy)
        .filter(
            Policy.id == policy_id,
            Policy.organization_id == admin_user.organization_id,
        )
        .first()
    )
    if not policy:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Policy not found.")

    before = snapshot(policy, _POLICY_FIELDS)
    update_data = payload.model_dump(exclude_unset=True)
    for field, val in update_data.items():
        setattr(policy, field, val)

    policy.version += 1
    policy.updated_by = admin_user.email
    policy.updated_at = datetime.now(timezone.utc)

    bump_policy_revision(db, admin_user.organization_id)
    db.commit()
    db.refresh(policy)
    record_admin_action(
        db, organization_id=admin_user.organization_id, actor=admin_user.email, action="policy.update",
        target_type="policy", target_id=policy.rule_id,
        summary=f"Updated policy '{policy.name}': {', '.join(f'{k}={v}' for k, v in update_data.items())}",
        before=before, after=snapshot(policy, _POLICY_FIELDS), request=request,
    )
    return policy


@router.delete("/{policy_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_policy(
    policy_id: str,
    request: Request,
    admin_user: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Deletes a policy. Catalog rules are recreated with their recommended action on restart; disable instead."""
    policy = (
        db.query(Policy)
        .filter(
            Policy.id == policy_id,
            Policy.organization_id == admin_user.organization_id,
        )
        .first()
    )
    if not policy:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Policy not found.")
    if policy.rule_id in RULE_IDS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Built-in rules cannot be deleted. Disable the rule or set its action to ALLOW instead.",
        )

    before = snapshot(policy, _POLICY_FIELDS)
    db.delete(policy)
    bump_policy_revision(db, admin_user.organization_id)
    db.commit()
    record_admin_action(
        db, organization_id=admin_user.organization_id, actor=admin_user.email, action="policy.delete",
        target_type="policy", target_id=before["rule_id"], summary=f"Deleted policy '{before['name']}'",
        before=before, request=request,
    )
    return None


@router.post("/apply-preset", response_model=PolicyListResponse)
def apply_preset(
    payload: ApplyPresetRequest,
    request: Request,
    admin_user: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Sets every built-in rule to the actions of a preset (recommended, strict or monitor) and enables it."""
    actions = PRESETS[payload.preset]
    org_id = admin_user.organization_id
    ensure_catalog_policies(db, org_id)
    changed = []
    for policy in db.query(Policy).filter(Policy.organization_id == org_id).all():
        target = actions.get(policy.rule_id)
        if target and (policy.action != target or not policy.enabled):
            changed.append(f"{policy.rule_id}: {policy.action} -> {target}")
            policy.action = target
            policy.enabled = True
            policy.version += 1
            policy.updated_by = admin_user.email
            policy.updated_at = datetime.now(timezone.utc)
    bump_policy_revision(db, org_id)
    db.commit()
    record_admin_action(
        db, organization_id=org_id, actor=admin_user.email, action="policy.preset",
        target_type="policy", target_id=payload.preset,
        summary=f"Applied '{payload.preset}' preset ({len(changed)} rules changed)",
        after={"changes": changed}, request=request,
    )
    return list_policies(site=None, principal=Principal(org_id, admin_user.id, False, user=admin_user), db=db)


@router.post("/evaluate", response_model=EvaluatePromptResponse)
def evaluate_prompt(
    payload: EvaluatePromptRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Dry-run sandbox endpoint.

    Evaluates a sample prompt against the organization's current rules without
    recording an audit event or modifying anything. Used by the interactive sandbox.
    """
    policies_db = (
        db.query(Policy)
        .filter(Policy.organization_id == current_user.organization_id)
        .all()
    )
    rule_objs = [
        PolicyRule(
            id=p.id,
            rule_id=p.rule_id,
            action=p.action,
            severity=p.severity,
            enabled=p.enabled,
            site_scope=p.site_scope,
        )
        for p in policies_db
    ]

    # Use the organization's dashboard-managed keywords, same as the extension does
    detector = DetectorEngine(
        custom_keywords=get_org_keywords(db, current_user.organization_id),
        include_defaults=False,
    )
    findings = detector.detect(payload.text)
    eval_result = PolicyEvaluator.evaluate(
        findings=findings,
        policies=rule_objs,
        site=payload.site,
        original_text=payload.text,
    )

    return EvaluatePromptResponse(
        action=eval_result.action,
        primary_rule_id=eval_result.primary_rule_id,
        highest_severity=eval_result.highest_severity,
        reason=eval_result.reason,
        needs_confirmation=eval_result.needs_confirmation,
        findings_count=len(eval_result.findings),
        findings=eval_result.findings,
        redacted_preview=eval_result.redacted_preview,
    )
