"""Personal API tokens ("API connections") and the read-only API they unlock.

Manage (signed-in admin or viewer of the account):
  GET    /api/v1/me/api-tokens
  POST   /api/v1/me/api-tokens          {name, scopes, expires_in_days} -> the token, shown once
  DELETE /api/v1/me/api-tokens/{id}     revoke

Use (Authorization: Bearer aspt_...):
  GET /api/v1/public/alerts   scope alerts:read  - own account's security alerts (no prompt text)
  GET /api/v1/public/usage    scope usage:read   - own account's usage and credit balance

Tokens are random (aspt_ + 43 chars), stored only as SHA-256 hashes, limited to the creator's
account, read-only, rate-limited, revocable and optionally expiring. They are never accepted by
any other endpoint (dashboard, extension or internal APIs).
"""
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core import ratelimit
from app.core.audit import record_admin_action
from app.core.entitlements import aware, current_entitlement, utcnow
from app.core.security import generate_secret, hash_device_key
from app.db.models import ApiToken, Organization, SecurityEvent, UsageDaily, User
from app.db.session import get_db

TOKEN_PREFIX = "aspt_"
SCOPES = {"alerts:read": "Read your security alerts", "usage:read": "Read your usage and credit balance"}
MAX_ACTIVE_TOKENS = 10

router = APIRouter(prefix="/api/v1/me/api-tokens", tags=["API tokens"])
public_router = APIRouter(prefix="/api/v1/public", tags=["Personal API"])


def _iso(dt) -> Optional[str]:
    return aware(dt).isoformat() if dt else None


def _out(t: ApiToken) -> dict:
    now = utcnow()
    state = "revoked" if t.revoked_at else ("expired" if t.expires_at and aware(t.expires_at) <= now else "active")
    return {"id": t.id, "name": t.name, "prefix": t.token_prefix, "scopes": t.scopes.split(), "state": state,
            "expires_at": _iso(t.expires_at), "last_used_at": _iso(t.last_used_at), "created_at": _iso(t.created_at)}


@router.get("")
def list_tokens(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(ApiToken).filter(ApiToken.user_id == user.id).order_by(ApiToken.created_at.desc()).all()
    return {"scopes": [{"scope": k, "label": v} for k, v in SCOPES.items()], "tokens": [_out(t) for t in rows]}


class TokenCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=80)
    scopes: List[str] = Field(..., min_length=1)
    expires_in_days: Optional[int] = Field(default=90, ge=1, le=365)  # None = no expiry


@router.post("", status_code=status.HTTP_201_CREATED)
def create_token(body: TokenCreate, request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ratelimit.hit("api-token-create", user.id, 10, 60 * 60, "Too many tokens created in the last hour.")
    scopes = sorted(set(body.scopes))
    if any(s not in SCOPES for s in scopes):
        raise HTTPException(status_code=400, detail="Unknown scope.")
    now = utcnow()
    active = db.query(ApiToken).filter(ApiToken.user_id == user.id, ApiToken.revoked_at.is_(None)).all()
    if len([t for t in active if not t.expires_at or aware(t.expires_at) > now]) >= MAX_ACTIVE_TOKENS:
        raise HTTPException(status_code=409, detail=f"You can have at most {MAX_ACTIVE_TOKENS} active tokens. Revoke one first.")
    raw = generate_secret(TOKEN_PREFIX)
    token = ApiToken(organization_id=user.organization_id, user_id=user.id, name=body.name.strip(), token_prefix=raw[:12],
                     token_hash=hash_device_key(raw), scopes=" ".join(scopes),
                     expires_at=now + timedelta(days=body.expires_in_days) if body.expires_in_days else None)
    db.add(token)
    db.commit()
    record_admin_action(db, organization_id=user.organization_id, actor=user.email, action="api_token.create",
                        target_type="api_token", target_id=token.token_prefix,
                        summary=f"Created API token '{token.name}' ({token.scopes})", request=request)
    return {**_out(token), "token": raw}


@router.delete("/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_token(token_id: str, request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    token = db.query(ApiToken).filter(ApiToken.id == token_id, ApiToken.user_id == user.id).first()
    if not token:
        raise HTTPException(status_code=404, detail="Token not found.")
    if token.revoked_at is None:
        token.revoked_at = utcnow()
        db.commit()
        record_admin_action(db, organization_id=user.organization_id, actor=user.email, action="api_token.revoke",
                            target_type="api_token", target_id=token.token_prefix, summary=f"Revoked API token '{token.name}'",
                            request=request)
    return None


# --- Using a token ---------------------------------------------------------------------------

def token_principal(scope: str):
    def dependency(authorization: Optional[str] = Header(default=None), db: Session = Depends(get_db)) -> ApiToken:
        raw = (authorization or "").removeprefix("Bearer ").strip()
        if not raw.startswith(TOKEN_PREFIX):
            raise HTTPException(status_code=401, detail="Send a personal API token: Authorization: Bearer aspt_...",
                                headers={"WWW-Authenticate": "Bearer"})
        token = db.query(ApiToken).filter(ApiToken.token_hash == hash_device_key(raw)).first()
        now = utcnow()
        if not token or token.revoked_at or (token.expires_at and aware(token.expires_at) <= now):
            raise HTTPException(status_code=401, detail="This API token is invalid, expired or revoked.")
        owner = db.query(User).filter(User.id == token.user_id, User.active == True).first()
        org = db.query(Organization).filter(Organization.id == token.organization_id).first()
        if not owner or owner.organization_id != token.organization_id or org is None or org.suspended_at is not None:
            raise HTTPException(status_code=403, detail="The account of this token is disabled or suspended.")
        if scope not in token.scopes.split():
            raise HTTPException(status_code=403, detail=f"This token does not have the {scope} scope.")
        ratelimit.hit("api-token-use", token.id, 60, 60, "Rate limit: 60 requests per minute per token.")
        if token.last_used_at is None or now - aware(token.last_used_at) > timedelta(minutes=1):
            token.last_used_at = now
            db.commit()
        return token

    return dependency


@public_router.get("/alerts")
def api_alerts(since: Optional[datetime] = None, limit: int = Query(100, ge=1, le=500),
               token: ApiToken = Depends(token_principal("alerts:read")), db: Session = Depends(get_db)):
    """Security alerts (blocked, warned, redacted, monitored prompts and blocked sites). Prompt text is never returned."""
    q = db.query(SecurityEvent).filter(SecurityEvent.organization_id == token.organization_id, SecurityEvent.action != "ALLOW")
    if since is not None:
        q = q.filter(SecurityEvent.occurred_at > (since if since.tzinfo else since.replace(tzinfo=timezone.utc)))
    rows = q.order_by(SecurityEvent.occurred_at.desc()).limit(limit).all()
    return {"alerts": [
        {"id": e.id, "occurred_at": _iso(e.occurred_at), "site": e.site, "rule_id": e.rule_id, "category": e.category,
         "severity": e.severity, "action": e.action, "outcome": e.outcome, "user": e.user_id}
        for e in rows
    ]}


@public_router.get("/usage")
def api_usage(token: ApiToken = Depends(token_principal("usage:read")), db: Session = Depends(get_db)):
    now = utcnow()
    ent = current_entitlement(db, token.organization_id, now)
    since = (now - timedelta(days=29)).strftime("%Y-%m-%d")
    rows = db.query(UsageDaily).filter(UsageDaily.organization_id == token.organization_id, UsageDaily.day >= since).all()
    daily = {}
    for r in rows:
        daily[r.day] = daily.get(r.day, 0) + int(r.prompt_checks or 0)
    e = ent.as_dict(now)
    return {
        "state": e["state"], "plan_code": e["plan_code"], "expires_at": e["expires_at"],
        "credit_balance": e["credit_balance"], "checks_this_month": e["checks_this_month"], "check_limit": e["check_limit"],
        "monthly_cap": e["monthly_cap"], "daily_prompt_checks_30d": [{"day": d, "prompt_checks": n} for d, n in sorted(daily.items())],
    }
