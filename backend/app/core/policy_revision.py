"""Blocking-configuration revision of an organization.

Every change the browsers enforce (protection rules, website categories, Safe Search, website
rules, keywords, settings) increments the organization's revision. Each browser checks the
revision about once a minute (GET /api/v1/policies/revision) and downloads the full sync only
when it differs, so a dashboard change reaches connected browsers within about a minute.

The caller commits the transaction that makes the change.
"""

from sqlalchemy.orm import Session

from app.db.models import Organization


def bump_policy_revision(db: Session, organization_id: str) -> None:
    """Marks the organization's enforced configuration as changed (caller commits)."""
    db.query(Organization).filter(Organization.id == organization_id).update(
        {Organization.policy_revision: Organization.policy_revision + 1},
        synchronize_session=False,
    )


def current_policy_revision(db: Session, organization_id: str) -> int:
    value = db.query(Organization.policy_revision).filter(Organization.id == organization_id).scalar()
    return int(value or 0)
