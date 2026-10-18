"""Invite friends (referrals) for the signed-in account.

  GET /api/v1/referrals   own account only: invite link, invited / pending / rewarded counts, bonus size

The organization comes from the credential; nothing in the request selects another account.
Rewards are granted in api/auth.py verify_email via core/referrals.py.
"""
from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.api.users import dashboard_url
from app.core.referrals import referral_summary
from app.db.models import Organization, User
from app.db.session import get_db

router = APIRouter(prefix="/api/v1/referrals", tags=["Referrals"])


@router.get("")
def my_referrals(request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    org = db.query(Organization).filter(Organization.id == user.organization_id).first()
    if org is None or (org.account_type or "COMPANY") != "INDIVIDUAL":
        return {"enabled": False}
    summary = referral_summary(db, org)
    return {"enabled": True, **summary, "link": f"{dashboard_url(request)}/#ref={summary['code']}"}
