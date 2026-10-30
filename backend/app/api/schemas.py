"""Pydantic schemas for AgentShield API requests and responses."""
from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, ConfigDict, EmailStr, Field, StrictBool, model_validator


# --- Auth Schemas ---
class LoginRequest(BaseModel):
    email: str = Field(..., max_length=255)
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: str
    email: str
    role: str
    organization_id: str
    organization_name: str
    account_type: str = "COMPANY"
    email_verified: bool = True
    email_verification_required: bool = False
    display_name: Optional[str] = None


# --- Policy Schemas ---
class PolicyCreate(BaseModel):
    name: str = Field(..., max_length=120)
    rule_id: str = Field(..., max_length=80)
    category: str = Field(..., max_length=50)
    site_scope: Optional[str] = Field(default="*", max_length=255)
    action: str = Field(..., pattern="^(ALLOW|MONITOR|WARN|BLOCK|REDACT)$")
    severity: str = Field(..., pattern="^(LOW|MEDIUM|HIGH|CRITICAL)$")
    enabled: bool = True


class PolicyUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=120)
    site_scope: Optional[str] = Field(None, max_length=255)
    action: Optional[str] = Field(None, pattern="^(ALLOW|MONITOR|WARN|BLOCK|REDACT)$")
    severity: Optional[str] = Field(None, pattern="^(LOW|MEDIUM|HIGH|CRITICAL)$")
    enabled: Optional[bool] = None


class PolicyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    organization_id: str
    name: str
    rule_id: str
    category: str
    site_scope: Optional[str]
    action: str
    severity: str
    enabled: bool
    version: int
    updated_by: Optional[str]
    updated_at: Optional[datetime]
    created_at: Optional[datetime]


class ExtensionSettings(BaseModel):
    """Settings the extension needs to enforce locally."""
    store_clean_prompt_text: bool = False
    store_violation_prompt_text: bool = True
    block_unapproved_ai: bool = False
    # Website categories to block ({"adult": true, ...}) and whether Safe Search is enforced
    web_categories: Dict[str, bool] = Field(default_factory=dict)
    safe_search: bool = False


class PolicyListResponse(BaseModel):
    organization_id: str
    organization_name: Optional[str] = None
    policy_version: int
    # Blocking-configuration revision: browsers resync when it changes (see core/policy_revision.py)
    policy_revision: int = 0
    last_synced_at: datetime
    policies: List[PolicyOut]
    # Confidential codewords managed from the dashboard; the extension replaces its defaults with these
    keywords: List[str] = Field(default_factory=list)
    settings: ExtensionSettings = Field(default_factory=ExtensionSettings)
    # Known generative-AI sites, used when block_unapproved_ai is on
    ai_domains: List[str] = Field(default_factory=list)
    # The account's current entitlement (core/entitlements.py as_dict), so a browser learns at its next sync
    # that free prompt checks paused or resumed without waiting for its next session
    entitlement: Optional[dict] = None


class RuleCatalogItem(BaseModel):
    rule_id: str
    category: str
    name: str
    description: str
    default_action: str
    default_severity: str


class ApplyPresetRequest(BaseModel):
    preset: str = Field(..., pattern="^(recommended|strict|monitor)$")


# --- Domain Traffic Control Schemas ---
class DomainRuleCreate(BaseModel):
    domain: str = Field(..., max_length=255)
    action: str = Field(default="BLOCK", pattern="^(BLOCK|ALLOW)$")
    category: Optional[str] = Field(default="Custom Domain Rule", max_length=100)
    description: Optional[str] = Field(default=None, max_length=255)
    enabled: bool = True


class DomainRuleUpdate(BaseModel):
    action: Optional[str] = Field(None, pattern="^(BLOCK|ALLOW)$")
    category: Optional[str] = Field(None, max_length=100)
    description: Optional[str] = Field(None, max_length=255)
    enabled: Optional[bool] = None


class DomainRuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    organization_id: str
    domain: str
    action: str
    category: Optional[str] = None
    description: Optional[str] = None
    enabled: bool
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class DomainRuleListResponse(BaseModel):
    organization_id: str
    total: int
    domains: List[DomainRuleOut]


# --- Event Ingestion Schemas ---
class SecurityEventCreate(BaseModel):
    site: str = Field(..., max_length=120)
    rule_id: str = Field(..., max_length=80)
    category: str = Field(..., max_length=50)
    severity: str = Field(..., pattern="^(LOW|MEDIUM|HIGH|CRITICAL)$")
    action: str = Field(..., pattern="^(ALLOW|MONITOR|WARN|BLOCK|REDACT)$")
    outcome: str = Field(..., max_length=50)
    user_id: Optional[str] = Field(default=None, max_length=100)
    # Accepted for compatibility with older extension builds but ignored:
    # the organization always comes from the caller's credentials.
    organization_id: Optional[str] = Field(default=None, max_length=80)
    company_name: Optional[str] = Field(default=None, max_length=120)
    extension_version: Optional[str] = Field(default="1.0.0", max_length=30)
    policy_version: Optional[int] = Field(default=1)
    department: Optional[str] = Field(default=None, max_length=100)
    application: Optional[str] = Field(default=None, max_length=100)
    prompt: Optional[str] = Field(default=None)  # Masked and size-limited by the backend before storage
    prompt_preview: Optional[str] = Field(default=None)
    dlp_engine: Optional[str] = Field(default="-", max_length=100)
    location: Optional[str] = Field(default=None, max_length=100)
    justification: Optional[str] = Field(default=None, max_length=500)  # Employee's reason for proceeding past a warning
    # Random id per event from the extension (retries and offline replays are stored and metered once)
    client_event_id: Optional[str] = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]{8,64}$")

    # Normalize prompt inputs from older clients that used other field names
    @model_validator(mode="before")
    @classmethod
    def process_prompt_payloads(cls, data: dict):
        if isinstance(data, dict):
            p = data.get("prompt") or data.get("raw_prompt") or data.get("text") or data.get("content") or data.get("prompt_preview")
            if p is not None and not data.get("prompt"):
                data["prompt"] = str(p)
        return data


class SecurityEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    organization_id: str
    company_name: Optional[str] = None
    user_id: Optional[str]
    occurred_at: datetime
    site: str
    rule_id: str
    category: str
    severity: str
    action: str
    outcome: str
    extension_version: str
    policy_version: int
    department: Optional[str] = None
    application: Optional[str] = None
    prompt: Optional[str] = None
    prompt_preview: Optional[str] = None
    dlp_engine: Optional[str] = "-"
    location: Optional[str] = None
    justification: Optional[str] = None


class EventsPaginatedResponse(BaseModel):
    total: int
    page: int
    page_size: int
    items: List[SecurityEventOut]



# --- Company Analytics & Bad Request Tracking Schema ---
class CompanyBreakdownItem(BaseModel):
    organization_id: str
    company_name: str
    total_events: int
    total_bad_requests: int  # Blocked + Warned + Redacted violations
    blocked_count: int
    warned_count: int
    redacted_count: int
    allowed_count: int
    top_violation_rule: Optional[str] = None
    latest_violation_at: Optional[datetime] = None


# --- Metrics Summary Schema ---
class MetricsSummaryResponse(BaseModel):
    total_events: int
    blocked_count: int
    warned_count: int
    redacted_count: int
    allowed_count: int
    monitored_count: int = 0
    events_last_24h: int = 0
    active_policies_count: int
    category_distribution: dict
    severity_distribution: dict
    # Overview charts: events per site (top 8, rest folded into "Other") and per UTC day (last 14 days)
    site_distribution: dict = Field(default_factory=dict)
    daily_events: List[dict] = Field(default_factory=list)
    recent_events: List[SecurityEventOut]
    company_breakdown: List[CompanyBreakdownItem] = Field(default_factory=list)


# --- Simulation / Policy Evaluation Schema ---
class EvaluatePromptRequest(BaseModel):
    text: str = Field(..., max_length=10000)
    site: Optional[str] = "chatgpt.com"


class EvaluatePromptResponse(BaseModel):
    action: str
    primary_rule_id: Optional[str]
    highest_severity: Optional[str]
    reason: str
    needs_confirmation: bool
    findings_count: int
    findings: List[dict]
    redacted_preview: Optional[str]


# --- User Governance & Investigation Schemas ---
class UserRiskSummary(BaseModel):
    user_id: str
    department: Optional[str] = None
    total_prompts: int
    good_prompts: int
    bad_prompts: int
    blocked_count: int
    warned_count: int
    redacted_count: int
    monitored_count: int = 0
    blocked_sites_count: int = 0
    status: str = "ACTIVE"  # ACTIVE, WARNED, RESTRICTED, SUSPENDED
    risk_level: str = "LOW"  # LOW, MEDIUM, HIGH, CRITICAL
    notes: Optional[str] = None
    action_taken_by: Optional[str] = None
    latest_activity: Optional[datetime] = None


class UserActionRequest(BaseModel):
    action: str = Field(..., pattern="^(SUSPEND|RESTRICT|WARN|RESTORE)$")
    notes: Optional[str] = Field(None, max_length=500)


class UserActionResponse(BaseModel):
    user_id: str
    status: str
    notes: Optional[str] = None
    action_taken_by: Optional[str] = None
    updated_at: datetime


# --- Account Schemas ---
class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=12, max_length=128)


# --- Organization Configuration Schemas ---
class DeviceKeyCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class DeviceKeyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    key_prefix: str
    active: bool
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None


class DeviceKeyCreated(DeviceKeyOut):
    key: str  # Plaintext key, returned only once


class KeywordCreate(BaseModel):
    keyword: str = Field(..., min_length=1, max_length=120)


class KeywordOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    keyword: str
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None


class OrgSettingsOut(BaseModel):
    organization_id: str
    organization_name: str
    retention_days: int
    store_clean_prompt_text: bool
    store_violation_prompt_text: bool
    block_unapproved_ai: bool = False
    require_device_approval: bool = False
    web_categories: Dict[str, bool] = Field(default_factory=dict)
    safe_search: bool = False
    # The blockable categories (id, name, description, default) for the dashboard
    web_category_catalog: List[Dict[str, Any]] = Field(default_factory=list)
    # Headings the dashboard groups the category switches under, and the one-click presets (core/catalog.py)
    web_category_groups: List[Dict[str, Any]] = Field(default_factory=list)
    web_category_presets: List[Dict[str, Any]] = Field(default_factory=list)
    demo_mode: bool = False  # Set by the server's DEMO_MODE environment variable, not editable
    updated_by: Optional[str] = None
    updated_at: Optional[datetime] = None


class OrgSettingsUpdate(BaseModel):
    retention_days: Optional[int] = Field(None, ge=1, le=3650)
    store_clean_prompt_text: Optional[bool] = None
    store_violation_prompt_text: Optional[bool] = None
    block_unapproved_ai: Optional[bool] = None
    require_device_approval: Optional[bool] = None
    # Only the categories sent are changed; unknown ids are rejected
    web_categories: Optional[Dict[str, StrictBool]] = None
    safe_search: Optional[StrictBool] = None


# --- Account & Audit Schemas ---
class MeResponse(BaseModel):
    user_id: str
    email: str
    role: str
    organization_id: str
    organization_name: str
    using_default_password: bool
    email_verified: bool = True
    email_verification_required: bool = False
    account_type: str = "COMPANY"
    display_name: Optional[str] = None


class AuditLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    occurred_at: datetime
    actor: Optional[str] = None
    action: str
    target_type: Optional[str] = None
    target_id: Optional[str] = None
    summary: Optional[str] = None
    details: Optional[str] = None
    ip_address: Optional[str] = None


class AuditLogPage(BaseModel):
    total: int
    items: List[AuditLogOut]


# --- Endpoint (protected browser) Schemas ---
class EndpointHeartbeat(BaseModel):
    device_id: str = Field(..., min_length=8, max_length=64)
    user_id: Optional[str] = Field(default=None, max_length=100)
    extension_version: Optional[str] = Field(default=None, max_length=30)
    browser: Optional[str] = Field(default=None, max_length=120)
    platform: Optional[str] = Field(default=None, max_length=60)
    policy_version: Optional[int] = None
    enrollment_source: Optional[str] = Field(default=None, max_length=30)


class EndpointOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    device_id: str
    user_id: Optional[str] = None
    extension_version: Optional[str] = None
    browser: Optional[str] = None
    platform: Optional[str] = None
    policy_version: Optional[int] = None
    enrollment_source: Optional[str] = None
    first_seen_at: Optional[datetime] = None
    last_seen_at: Optional[datetime] = None
    status: str = "OFFLINE"          # ONLINE (seen < 15 min), STALE (< 24 h), OFFLINE
    policy_current: bool = True      # Has the latest policy version


class EndpointSummary(BaseModel):
    total: int
    online: int
    stale: int
    offline: int
    outdated_policy: int
    current_policy_version: int
    items: List[EndpointOut]


# --- Accounts, invites, activation and devices ---
ROLE_PATTERN = "^(ADMIN|VIEWER|EMPLOYEE)$"


class InviteCreate(BaseModel):
    email: str = Field(..., min_length=3, max_length=255, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    role: str = Field(default="EMPLOYEE", pattern=ROLE_PATTERN)


class InviteInfo(BaseModel):
    email: str
    organization_name: str
    role: str
    expires_at: datetime


class SignUpRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=255, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str = Field(..., min_length=12, max_length=256)
    name: Optional[str] = Field(default=None, max_length=120)
    # INDIVIDUAL (available) or COMPANY (refused unless COMPANY_SIGNUP_ENABLED; "coming soon")
    account_type: str = Field(default="INDIVIDUAL", pattern="^(INDIVIDUAL|COMPANY)$")
    company_name: Optional[str] = Field(default=None, max_length=100)
    # Optional invite code from a friend's link (#ref=<code>); an unknown code is ignored
    referral_code: Optional[str] = Field(default=None, max_length=32)


class ResetPasswordRequest(BaseModel):
    token: str = Field(..., min_length=10, max_length=200)
    password: str = Field(..., min_length=12, max_length=256)


class EmailRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=255)


class VerifyEmailRequest(BaseModel):
    token: str = Field(..., min_length=10, max_length=200)


class AcceptInviteRequest(BaseModel):
    token: str = Field(..., min_length=10, max_length=200)
    password: str = Field(..., min_length=12, max_length=256)


class InviteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    email: str
    role: str
    expires_at: datetime
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None


class InviteSent(InviteOut):
    delivery: str  # "smtp" or "log" (development: link written to the server log)


class AccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    email: str
    role: str
    active: bool
    email_verified_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    device_count: int = 0


class UsersPage(BaseModel):
    users: List[AccountOut]
    pending_invites: List[InviteOut]


class AccountUpdate(BaseModel):
    active: Optional[bool] = None
    role: Optional[str] = Field(default=None, pattern=ROLE_PATTERN)


class ActivationTokenCreated(BaseModel):
    token: str          # Plaintext, returned once
    token_prefix: str
    expires_at: datetime
    api_url: str        # Server address the extension should use


class DeviceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    user_email: Optional[str] = None
    status: str
    browser: Optional[str] = None
    platform: Optional[str] = None
    created_at: Optional[datetime] = None
    approved_by: Optional[str] = None
    last_seen_at: Optional[datetime] = None
    revoked_at: Optional[datetime] = None
    revoked_by: Optional[str] = None
    # Browsers connected through the AgentShield Windows app belong to a PC (signed out together)
    computer_id: Optional[str] = None
    computer_name: Optional[str] = None


class DeviceActivateRequest(BaseModel):
    activation_token: str = Field(..., min_length=10, max_length=200)
    public_key: str = Field(..., min_length=40, max_length=400)  # base64 SPKI, ECDSA P-256
    browser: Optional[str] = Field(default=None, max_length=120)
    platform: Optional[str] = Field(default=None, max_length=60)


class DeviceActivateResponse(BaseModel):
    device_id: str
    status: str               # ACTIVE or PENDING
    organization_name: str
    user_email: str


class DeviceChallengeRequest(BaseModel):
    device_id: str = Field(..., min_length=8, max_length=64)


class DeviceChallengeResponse(BaseModel):
    nonce: str
    expires_in: int


class DeviceSessionRequest(BaseModel):
    device_id: str = Field(..., min_length=8, max_length=64)
    nonce: str = Field(..., min_length=10, max_length=2000)
    signature: str = Field(..., min_length=40, max_length=200)  # base64 raw r||s


class DeviceSessionResponse(BaseModel):
    session_token: str
    expires_in: int
    device_id: str
    user_email: str
    organization_id: str
    organization_name: str
    entitlement: dict = {}
