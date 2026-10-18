"""SQLAlchemy Database Models for AgentShield.

Defines the core database schema:
1. Organization: Multi-tenant boundary isolating users, rules, and events.
2. User: Administrator and auditor accounts with role-based access.
3. Policy: Content inspection rules (e.g., block API keys, warn on PII).
4. SecurityEvent: Audit log entries capturing security interventions and prompt telemetry.
5. DomainRule: Network traffic rules for blocking or allowing external web domains.
"""

import uuid
from datetime import datetime, timezone
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship
from app.db.session import Base


def generate_uuid() -> str:
    """Helper to generate standard UUID strings for primary keys."""
    return str(uuid.uuid4())


def utc_now() -> datetime:
    """Helper to return current UTC datetime with timezone awareness."""
    return datetime.now(timezone.utc)


class Organization(Base):
    """Customer or department organization for tenant isolation."""
    __tablename__ = "organizations"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    name = Column(String(100), nullable=False)
    retention_days = Column(Integer, default=30)
    created_at = Column(DateTime(timezone=True), default=utc_now)
    # Set by the platform operator: every browser and activation code of this company is locked
    suspended_at = Column(DateTime(timezone=True), nullable=True)
    suspended_reason = Column(String(255), nullable=True)
    # INDIVIDUAL: one-person account from public sign-up. COMPANY: multi-user workspace
    # (public company sign-up is "coming soon"; existing company tenants keep working).
    account_type = Column(String(12), nullable=False, default="COMPANY")
    # Prepaid pay-as-you-go credits (1 credit = 1 prompt check). Changed only by verified payments,
    # metering, refunds and audited staff grants; every change except metering is in credit_ledger.
    credit_balance = Column(Integer, nullable=False, default=0)
    # Optional self-imposed limit on prompt checks per calendar month (UTC); NULL = no cap
    monthly_check_cap = Column(Integer, nullable=True)
    # Random code for "invite a friend" links (#ref=<code>); created on first use (core/referrals.py)
    referral_code = Column(String(16), nullable=True, unique=True)
    # When the account chose the Free plan (POST /api/v1/billing/free). Free forever is never automatic:
    # an account has no access until it chooses the Free plan, the trial, a paid plan or credits.
    free_started_at = Column(DateTime(timezone=True), nullable=True)

    # Relationships: Deleting an org cleanly cascades to its dependent records
    users = relationship("User", back_populates="organization", cascade="all, delete-orphan")
    policies = relationship("Policy", back_populates="organization", cascade="all, delete-orphan")
    security_events = relationship("SecurityEvent", back_populates="organization", cascade="all, delete-orphan")
    domain_rules = relationship("DomainRule", back_populates="organization", cascade="all, delete-orphan")


class User(Base):
    """Accounts: dashboard operators (ADMIN, VIEWER) and employees (EMPLOYEE).

    Employees can only sign in to generate activation codes and manage their own devices.
    Accounts are created from an admin invite; accepting it proves the email address.
    """
    __tablename__ = "users"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(50), default="ADMIN")  # ADMIN, VIEWER, EMPLOYEE (internal staff are StaffUser)
    active = Column(Boolean, default=True)
    email_verified_at = Column(DateTime(timezone=True), nullable=True)
    # Bumped on password change/reset and "sign out everywhere"; dashboard tokens carry it ("sv")
    session_version = Column(Integer, default=0, nullable=False)
    display_name = Column(String(120), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)

    organization = relationship("Organization", back_populates="users")


class Policy(Base):
    """Content inspection rules enforced locally in browser extension or verified on backend."""
    __tablename__ = "policies"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(120), nullable=False)
    rule_id = Column(String(80), nullable=False, index=True)
    category = Column(String(50), nullable=False)  # SECRET, PII, RESTRICTED
    site_scope = Column(String(255), nullable=True, default="*")  # Specific domain (e.g. chatgpt.com) or '*' for all
    action = Column(String(20), nullable=False, default="BLOCK")  # ALLOW, WARN, BLOCK, REDACT
    severity = Column(String(20), nullable=False, default="HIGH")  # LOW, MEDIUM, HIGH, CRITICAL
    enabled = Column(Boolean, default=True)
    version = Column(Integer, default=1)
    updated_by = Column(String(100), default="system")
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    created_at = Column(DateTime(timezone=True), default=utc_now)

    organization = relationship("Organization", back_populates="policies")


class SecurityEvent(Base):
    """Audit log recorded when a user prompt triggers a policy or a domain is blocked.

    Captures rule IDs, actions taken (BLOCK, WARN, REDACT), and optional prompt previews
    for forensic audit and compliance verification.
    """
    __tablename__ = "security_events"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(100), nullable=True)  # User or device identifier (e.g., 'emp-user-101')
    occurred_at = Column(DateTime(timezone=True), default=utc_now, index=True)
    site = Column(String(120), nullable=False)  # Hostname where event occurred (e.g. "chatgpt.com")
    rule_id = Column(String(80), nullable=False, index=True)
    category = Column(String(50), nullable=False)
    severity = Column(String(20), nullable=False)
    action = Column(String(20), nullable=False)  # ALLOW, WARN, BLOCK, REDACT
    outcome = Column(String(50), nullable=False)  # blocked, warned_and_confirmed, redacted, navigation_blocked, etc.
    extension_version = Column(String(30), default="1.0.0")
    policy_version = Column(Integer, default=1)

    # Enterprise audit and forensic context
    department = Column(String(100), nullable=True, default="Engineering")
    application = Column(String(100), nullable=True, default="ChatGPT")
    prompt = Column(Text, nullable=True)  # Full prompt content for security team review
    prompt_preview = Column(Text, nullable=True)  # Truncated or redacted preview
    dlp_engine = Column(String(100), nullable=True, default="-")
    location = Column(String(100), nullable=True, default="-")
    justification = Column(Text, nullable=True)  # Reason the employee gave when proceeding past a warning
    # Random id from the extension, so a retried or replayed event is stored (and metered) once
    client_event_id = Column(String(64), nullable=True)

    organization = relationship("Organization", back_populates="security_events")

    __table_args__ = (
        Index("ix_org_occurred_at", "organization_id", "occurred_at"),
        UniqueConstraint("organization_id", "client_event_id", name="uq_events_client_event"),
    )


class UsageDaily(Base):
    """Metered usage per account and person per UTC day (prompt checks are the billable unit)."""
    __tablename__ = "usage_daily"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_email = Column(String(255), nullable=False, default="")
    day = Column(String(10), nullable=False)               # YYYY-MM-DD (UTC)
    prompt_checks = Column(Integer, nullable=False, default=0)
    credit_checks = Column(Integer, nullable=False, default=0)   # of which paid with credits
    blocked = Column(Integer, nullable=False, default=0)
    warned = Column(Integer, nullable=False, default=0)
    redacted = Column(Integer, nullable=False, default=0)

    __table_args__ = (
        UniqueConstraint("organization_id", "user_email", "day", name="uq_usage_daily"),
        Index("ix_usage_daily_org_day", "organization_id", "day"),
    )


class CreditLedger(Base):
    """Every change to an account's credit balance other than per-prompt usage (which is in usage_daily)."""
    __tablename__ = "credit_ledger"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    delta = Column(Integer, nullable=False)
    kind = Column(String(20), nullable=False)          # purchase, grant, refund, dispute, dispute_won
    reference = Column(String(120), nullable=True)     # payment id or staff email
    note = Column(String(255), nullable=True)
    balance_after = Column(Integer, nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, index=True)


class Referral(Base):
    """An account that signed up from another account's invite link. Both get bonus prompt checks
    (credits, ledger kind REFERRAL) once the invited person confirms their email (core/referrals.py)."""
    __tablename__ = "referrals"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    referrer_org_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    # One referral per invited account
    referred_org_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, unique=True)
    status = Column(String(10), nullable=False, default="PENDING")   # PENDING, REWARDED, NOT_REWARDED
    created_at = Column(DateTime(timezone=True), default=utc_now)
    rewarded_at = Column(DateTime(timezone=True), nullable=True)


class ApiToken(Base):
    """Personal API token (aspt_...) to read one's own alerts and usage. Only a SHA-256 hash is stored."""
    __tablename__ = "api_tokens"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(80), nullable=False)
    token_prefix = Column(String(16), nullable=False)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    scopes = Column(String(120), nullable=False)       # space-separated: alerts:read usage:read
    expires_at = Column(DateTime(timezone=True), nullable=True)
    last_used_at = Column(DateTime(timezone=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)


class DomainRule(Base):
    """Domain traffic control rules for blocking shadow AI or unauthorized file converters."""
    __tablename__ = "domain_rules"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    domain = Column(String(255), nullable=False, index=True)
    action = Column(String(20), nullable=False, default="BLOCK")  # BLOCK or ALLOW
    category = Column(String(100), nullable=True, default="File Converter / Shadow AI")
    description = Column(String(255), nullable=True)
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)

    organization = relationship("Organization", back_populates="domain_rules")


class UserGovernance(Base):
    """Tracks employee risk standing and administrative enforcement actions (e.g. suspension, warning)."""
    __tablename__ = "user_governance"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(100), nullable=False, index=True)
    status = Column(String(30), default="ACTIVE")  # ACTIVE, WARNED, RESTRICTED, SUSPENDED
    risk_score = Column(Integer, default=0)
    notes = Column(Text, nullable=True)
    action_taken_by = Column(String(100), nullable=True)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    created_at = Column(DateTime(timezone=True), default=utc_now)

    organization = relationship("Organization")


class DeviceKey(Base):
    """Low-privilege enrollment key that browser extensions use to talk to the API.

    A device key can only read its organization's policies, domains and keywords,
    check an employee's governance status, and submit audit events. Only a
    SHA-256 hash is stored; the plaintext key is shown once, when it is created.
    """
    __tablename__ = "device_keys"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(120), nullable=False)
    key_hash = Column(String(64), nullable=False, unique=True, index=True)
    key_prefix = Column(String(16), nullable=False)  # First characters, shown in the dashboard to identify the key
    active = Column(Boolean, default=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)
    last_used_at = Column(DateTime(timezone=True), nullable=True)

    organization = relationship("Organization")


class UserInvite(Base):
    """Email invitation to create an account. Only the SHA-256 of the link token is stored."""
    __tablename__ = "user_invites"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    email = Column(String(255), nullable=False, index=True)
    role = Column(String(50), nullable=False, default="EMPLOYEE")
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    accepted_at = Column(DateTime(timezone=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)


class EmailVerification(Base):
    """Single-use emailed link: email confirmation ("verify") or password reset ("reset")."""
    __tablename__ = "email_verifications"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    purpose = Column(String(10), nullable=False, default="verify")
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    used_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)


class ActivationToken(Base):
    """Single-use code a signed-in user generates to activate one browser.

    It is bound to the user who created it and is only accepted together with that
    user's password and a new device public key.
    """
    __tablename__ = "activation_tokens"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    token_prefix = Column(String(16), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    used_at = Column(DateTime(timezone=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)
    # Set when the AgentShield Windows app of a connected PC created the code for one of its browsers
    computer_id = Column(String(36), nullable=True, index=True)


class Computer(Base):
    """A PC connected once through the AgentShield Windows app (2.4).

    The app holds a non-exportable ECDSA P-256 key in the Windows user's key store and proves possession
    of it to get single-use activation codes for the browsers on that PC, which then activate as ordinary
    Devices linked to this PC. A PC uses one device slot of the plan, however many browsers it has.
    """
    __tablename__ = "computers"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(120), nullable=True)            # Windows computer name, for the portal
    platform = Column(String(60), nullable=True)
    public_key = Column(Text, nullable=False)            # SPKI, base64
    status = Column(String(20), nullable=False, default="ACTIVE")  # ACTIVE, REVOKED
    activation_token_id = Column(String(36), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)
    last_seen_at = Column(DateTime(timezone=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    revoked_by = Column(String(255), nullable=True)


class Device(Base):
    """A browser authorized for one user, identified by a key pair that never leaves it.

    The extension proves possession of the private key (ECDSA P-256) to obtain short-lived
    sessions, so copying its files or storage to another browser grants nothing.
    """
    __tablename__ = "devices"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    public_key = Column(Text, nullable=False)  # SPKI, base64
    status = Column(String(20), nullable=False, default="ACTIVE")  # PENDING, ACTIVE, REVOKED
    browser = Column(String(120), nullable=True)
    platform = Column(String(60), nullable=True)
    activation_token_id = Column(String(36), nullable=True)
    # Browsers connected through the AgentShield Windows app belong to that PC (computers.id)
    computer_id = Column(String(36), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)
    approved_by = Column(String(255), nullable=True)
    last_seen_at = Column(DateTime(timezone=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    revoked_by = Column(String(255), nullable=True)


class Plan(Base):
    """A product the platform offers (trial, monthly, six-month, annual, internal). Edited by the platform admin."""
    __tablename__ = "plans"

    code = Column(String(30), primary_key=True)          # trial, monthly, six_month, annual, internal, credits_*
    name = Column(String(80), nullable=False)
    kind = Column(String(10), nullable=False)            # TRIAL, PAID, INTERNAL, CREDITS
    duration_days = Column(Integer, nullable=True)       # used when duration_months is not set
    duration_months = Column(Integer, nullable=True)
    device_limit = Column(Integer, nullable=False, default=3)
    price_minor = Column(Integer, nullable=True)         # in the currency's minor unit (paise); NULL = not priced yet
    currency = Column(String(3), nullable=False, default="INR")
    billing = Column(String(20), nullable=False, default="one_time")  # one_time or recurring
    features = Column(Text, nullable=True)               # JSON list of feature lines shown in the portal
    purchasable = Column(Boolean, default=False)
    active = Column(Boolean, default=True)
    sort = Column(Integer, default=0)
    # Razorpay plan used for recurring billing; recreated when the price changes
    razorpay_plan_id = Column(String(60), nullable=True)
    razorpay_plan_amount = Column(Integer, nullable=True)
    # CREDITS plans are prepaid credit packs: this many prompt checks per purchase
    credits = Column(Integer, nullable=True)
    # TRIAL/PAID plans: prompt checks included per calendar month (UTC); NULL = unlimited
    check_limit = Column(Integer, nullable=True)
    updated_by = Column(String(255), nullable=True)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class BillingOrder(Base):
    """A purchase attempt. Paid only after the payment provider confirms it (webhook or server-side fetch)."""
    __tablename__ = "billing_orders"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(36), nullable=True)
    plan_code = Column(String(30), nullable=False)
    kind = Column(String(15), nullable=False)          # one_time or subscription
    amount_minor = Column(Integer, nullable=False)
    currency = Column(String(3), nullable=False)
    provider = Column(String(20), nullable=False, default="razorpay")
    provider_order_id = Column(String(60), nullable=True, unique=True)
    provider_subscription_id = Column(String(60), nullable=True, index=True)
    # created, paid, failed, cancelled, refunded, partially_refunded, disputed
    status = Column(String(20), nullable=False, default="created")
    failure_reason = Column(String(255), nullable=True)
    receipt_number = Column(String(30), nullable=True, unique=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, index=True)
    paid_at = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class BillingPayment(Base):
    """A captured payment. UNIQUE provider_payment_id: one payment can never grant two entitlements."""
    __tablename__ = "billing_payments"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    order_id = Column(String(36), ForeignKey("billing_orders.id", ondelete="SET NULL"), nullable=True, index=True)
    provider_payment_id = Column(String(60), nullable=False, unique=True)
    amount_minor = Column(Integer, nullable=False)
    currency = Column(String(3), nullable=False)
    method = Column(String(30), nullable=True)
    # captured, refunded, partially_refunded, disputed
    status = Column(String(20), nullable=False, default="captured")
    refunded_minor = Column(Integer, nullable=False, default=0)
    license_id = Column(String(36), nullable=True)
    receipt_number = Column(String(30), nullable=True, unique=True)
    created_at = Column(DateTime(timezone=True), default=utc_now, index=True)


class BillingSubscription(Base):
    """A recurring (monthly) subscription at the payment provider."""
    __tablename__ = "billing_subscriptions"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    plan_code = Column(String(30), nullable=False)
    provider_subscription_id = Column(String(60), nullable=False, unique=True)
    # created, authenticated, active, pending, halted, cancelled, completed
    status = Column(String(20), nullable=False, default="created")
    cancel_at_period_end = Column(Boolean, default=False)
    current_end = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class WebhookEvent(Base):
    """Every payment-provider webhook received; UNIQUE event id makes processing idempotent."""
    __tablename__ = "webhook_events"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    provider = Column(String(20), nullable=False, default="razorpay")
    provider_event_id = Column(String(80), nullable=False, unique=True)
    event = Column(String(60), nullable=False)
    status = Column(String(20), nullable=False, default="received")  # received, processed, ignored, failed
    error = Column(String(500), nullable=True)
    received_at = Column(DateTime(timezone=True), default=utc_now, index=True)
    processed_at = Column(DateTime(timezone=True), nullable=True)


class License(Base):
    """A company's entitlement to use the extension for a period. Server time decides validity."""
    __tablename__ = "licenses"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    plan_code = Column(String(30), nullable=False)
    kind = Column(String(10), nullable=False)            # TRIAL, PAID, INTERNAL
    status = Column(String(10), nullable=False, default="ACTIVE")  # ACTIVE or REVOKED (expiry is derived from expires_at)
    starts_at = Column(DateTime(timezone=True), nullable=False, default=utc_now)
    expires_at = Column(DateTime(timezone=True), nullable=True)  # NULL only for INTERNAL licences
    device_limit = Column(Integer, nullable=False, default=3)
    payment_ref = Column(String(120), nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    revoked_by = Column(String(255), nullable=True)
    revoked_reason = Column(String(255), nullable=True)

    __table_args__ = (Index("ix_licenses_org_expires", "organization_id", "expires_at"),)


class TrialClaim(Base):
    """One free trial per company and per (normalized) email; unique constraints make double claims impossible."""
    __tablename__ = "trial_claims"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, unique=True)
    user_id = Column(String(36), nullable=False)
    email_normalized = Column(String(255), nullable=False, unique=True)
    email_domain = Column(String(255), nullable=False, index=True)
    ip_hash = Column(String(64), nullable=True, index=True)
    license_id = Column(String(36), nullable=True)
    claimed_at = Column(DateTime(timezone=True), default=utc_now, index=True)


class LicenseAdjustment(Base):
    """Record of every manual licence change (e.g. a trial extension) by the platform admin."""
    __tablename__ = "license_adjustments"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    license_id = Column(String(36), ForeignKey("licenses.id", ondelete="CASCADE"), nullable=False, index=True)
    old_expires_at = Column(DateTime(timezone=True), nullable=True)
    new_expires_at = Column(DateTime(timezone=True), nullable=True)
    reason = Column(String(500), nullable=False)
    created_by = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), default=utc_now)


class Notification(Base):
    """In-app (and emailed) notices such as trial reminders. UNIQUE(license_id, kind) keeps reminders idempotent."""
    __tablename__ = "notifications"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    license_id = Column(String(36), nullable=True)
    kind = Column(String(40), nullable=False)           # expires_7d, expires_3d, expires_1d, expired
    title = Column(String(200), nullable=False)
    body = Column(Text, nullable=True)
    emailed = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), default=utc_now, index=True)
    read_at = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (UniqueConstraint("license_id", "kind", name="uq_notifications_license_kind"),)


class ExtensionRelease(Base):
    """Published extension versions shown on the download page."""
    __tablename__ = "extension_releases"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    version = Column(String(30), nullable=False, unique=True)
    notes = Column(Text, nullable=True)
    sha256 = Column(String(64), nullable=True)
    size_bytes = Column(Integer, nullable=True)
    min_chrome = Column(String(10), nullable=True, default="110")
    min_edge = Column(String(10), nullable=True, default="110")
    is_current = Column(Boolean, default=False)
    published_at = Column(DateTime(timezone=True), default=utc_now)
    published_by = Column(String(255), nullable=True)


class RestrictedKeyword(Base):
    """Confidential codewords managed from the dashboard and synced to every extension."""
    __tablename__ = "restricted_keywords"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    keyword = Column(String(120), nullable=False)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)

    organization = relationship("Organization")


class AdminAuditLog(Base):
    """Record of every administrative change and sign-in attempt, for accountability."""
    __tablename__ = "admin_audit_log"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=True, index=True)
    occurred_at = Column(DateTime(timezone=True), default=utc_now, index=True)
    actor = Column(String(255), nullable=True)        # Operator email, or the email tried for failed logins
    action = Column(String(80), nullable=False)       # e.g. policy.update, login.failed
    target_type = Column(String(50), nullable=True)   # policy, domain, keyword, settings, device_key, employee, user
    target_id = Column(String(255), nullable=True)
    summary = Column(String(500), nullable=True)      # Human-readable description
    details = Column(Text, nullable=True)             # JSON: before / after values (never secrets)
    ip_address = Column(String(64), nullable=True)
    actor_type = Column(String(10), nullable=True, default="customer")  # customer, staff, system


class StaffUser(Base):
    """AgentShieldAI internal staff (admin console). Separate from customer accounts; MFA is mandatory."""
    __tablename__ = "staff_users"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    name = Column(String(120), nullable=True)
    password_hash = Column(String(255), nullable=True)   # NULL until an invite is accepted
    # PLATFORM_OWNER, PLATFORM_ADMIN, SECURITY_ANALYST, SUPPORT_AGENT, BILLING_ADMIN, READONLY_ANALYST
    role = Column(String(30), nullable=False)
    active = Column(Boolean, default=True, nullable=False)
    totp_secret_enc = Column(Text, nullable=True)        # Fernet-encrypted authenticator secret
    totp_enabled_at = Column(DateTime(timezone=True), nullable=True)
    totp_last_step = Column(Integer, nullable=True)      # last accepted 30-second step (replay protection)
    must_change_password = Column(Boolean, default=False, nullable=False)
    session_version = Column(Integer, default=0, nullable=False)
    last_login_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)


class StaffRecoveryCode(Base):
    """Single-use MFA recovery codes (hashed)."""
    __tablename__ = "staff_recovery_codes"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    staff_id = Column(String(36), ForeignKey("staff_users.id", ondelete="CASCADE"), nullable=False, index=True)
    code_hash = Column(String(255), nullable=False)
    used_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)


class StaffInvite(Base):
    """Invite link for a new staff member (token stored as a SHA-256 hash)."""
    __tablename__ = "staff_invites"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    staff_id = Column(String(36), ForeignKey("staff_users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    accepted_at = Column(DateTime(timezone=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)


class Endpoint(Base):
    """A browser with the extension installed, reported by periodic heartbeats."""
    __tablename__ = "endpoints"

    id = Column(String(36), primary_key=True, default=generate_uuid, index=True)
    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    device_id = Column(String(64), nullable=False, index=True)  # Random ID generated once per browser profile
    user_id = Column(String(100), nullable=True)
    device_key_id = Column(String(36), nullable=True)
    extension_version = Column(String(30), nullable=True)
    browser = Column(String(120), nullable=True)
    platform = Column(String(60), nullable=True)
    policy_version = Column(Integer, nullable=True)
    enrollment_source = Column(String(30), nullable=True)  # managed_policy, installer, enrollment_code
    first_seen_at = Column(DateTime(timezone=True), default=utc_now)
    last_seen_at = Column(DateTime(timezone=True), default=utc_now, index=True)


class OrganizationSettings(Base):
    """Per-organization privacy and retention settings, editable from the dashboard."""
    __tablename__ = "organization_settings"

    organization_id = Column(String(36), ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True)
    # Store the full text of prompts that triggered no rule. Off by default for employee privacy.
    store_clean_prompt_text = Column(Boolean, default=False)
    # Store the (secret-masked) text of prompts that triggered a rule, for investigations.
    store_violation_prompt_text = Column(Boolean, default=True)
    # Block every known AI website that is not on the organization's ALLOW list ("shadow AI").
    block_unapproved_ai = Column(Boolean, default=False)
    # New browsers stay PENDING until an admin approves them.
    require_device_approval = Column(Boolean, default=False)
    # Website categories to block: JSON {"adult": true, ...}; NULL/missing keys = catalog defaults
    web_categories = Column(Text, nullable=True)
    # Safe Search / YouTube Restricted Mode; NULL = follow the "adult" category
    safe_search = Column(Boolean, nullable=True)
    updated_by = Column(String(255), nullable=True)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)

    organization = relationship("Organization")
