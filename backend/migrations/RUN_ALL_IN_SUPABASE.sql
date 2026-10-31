-- ==============================================================================
-- AgentShieldAI - ALL migrations in one file, for the Supabase SQL Editor (optional).
--
-- You normally do NOT need this: the backend creates every table, column and Row Level
-- Security setting itself the first time it starts. Run this only AFTER the backend has
-- started once on Render, to apply/verify everything explicitly. Safe to run more than once.
--
-- The only migration file: the dated sections below were separate files, applied in this order.
-- Add new changes as a new section at the end (and to _align_schema in backend/app/db/seed.py).
-- ==============================================================================

-- >>>>>>>>>> 2026_10_production_hardening.sql
-- ==============================================================================
-- AgentShield - Production hardening migration (October 2026)
--
-- Run once in the Supabase SQL Editor on an EXISTING AgentShield database.
-- Safe to run more than once. The backend also creates the new tables itself on
-- startup; this file is mainly needed for step 2 (Row Level Security).
-- ==============================================================================

-- 1. New tables used by device keys, dashboard-managed keywords and privacy settings
CREATE TABLE IF NOT EXISTS user_governance (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id VARCHAR(100) NOT NULL,
    status VARCHAR(30) DEFAULT 'ACTIVE',
    risk_score INTEGER DEFAULT 0,
    notes TEXT,
    action_taken_by VARCHAR(100),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_governance_org ON user_governance(organization_id);
CREATE INDEX IF NOT EXISTS idx_user_governance_user ON user_governance(user_id);

CREATE TABLE IF NOT EXISTS device_keys (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    key_hash VARCHAR(64) NOT NULL UNIQUE,      -- SHA-256 of the key; the key itself is never stored
    key_prefix VARCHAR(16) NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    created_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_device_keys_org ON device_keys(organization_id);

CREATE TABLE IF NOT EXISTS restricted_keywords (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    keyword VARCHAR(120) NOT NULL,
    created_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_restricted_keywords_org ON restricted_keywords(organization_id);

CREATE TABLE IF NOT EXISTS organization_settings (
    organization_id VARCHAR(36) PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    store_clean_prompt_text BOOLEAN DEFAULT FALSE,
    store_violation_prompt_text BOOLEAN DEFAULT TRUE,
    updated_by VARCHAR(255),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Row Level Security
-- Supabase exposes every table in the public schema through its REST API.
-- Without RLS, anyone holding the project's public "anon" key can read these tables,
-- including password hashes and audit events. The AgentShield backend connects as
-- the database owner, which bypasses RLS, so enabling it (with no policies) closes
-- the REST API while the backend keeps working.
ALTER TABLE organizations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies              ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_rules          ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_governance       ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_keys           ENABLE ROW LEVEL SECURITY;
ALTER TABLE restricted_keywords   ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_settings ENABLE ROW LEVEL SECURITY;

-- 3. Mask plaintext credentials already stored by older versions
-- (older extension builds sent the raw prompt). Removes the prompt text of
-- past SECRET events; the masked preview, rule and metadata are kept.
UPDATE security_events SET prompt = NULL WHERE category = 'SECRET';

SELECT 'AgentShield production hardening applied.' AS status;


-- >>>>>>>>>> 2026_10_enterprise_features.sql
-- ==============================================================================
-- AgentShield 1.2 - Enterprise features migration (October 2026)
--
-- Run once in the Supabase SQL Editor on an existing database, AFTER
-- 2026_10_production_hardening.sql. Safe to run more than once.
-- The backend also creates these on startup and enables Row Level Security on
-- PostgreSQL automatically; this file lets you apply and verify it explicitly.
-- ==============================================================================

-- Admin audit trail (policy/settings changes, sign-ins, exports)
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) REFERENCES organizations(id) ON DELETE CASCADE,
    occurred_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    actor VARCHAR(255),
    action VARCHAR(80) NOT NULL,
    target_type VARCHAR(50),
    target_id VARCHAR(255),
    summary VARCHAR(500),
    details TEXT,
    ip_address VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_org_time ON admin_audit_log(organization_id, occurred_at DESC);

-- Protected browsers (heartbeats from enrolled extensions)
CREATE TABLE IF NOT EXISTS endpoints (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(100),
    device_key_id VARCHAR(36),
    extension_version VARCHAR(30),
    browser VARCHAR(120),
    platform VARCHAR(60),
    policy_version INTEGER,
    enrollment_source VARCHAR(30),
    first_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_endpoints_org ON endpoints(organization_id);
CREATE INDEX IF NOT EXISTS idx_endpoints_device ON endpoints(device_id);

-- New columns
ALTER TABLE security_events       ADD COLUMN IF NOT EXISTS justification TEXT;
ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS block_unapproved_ai BOOLEAN DEFAULT FALSE;

-- Row Level Security on the new tables (closes the Supabase REST API)
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE endpoints       ENABLE ROW LEVEL SECURITY;

-- Verify: every AgentShield table should show rowsecurity = true
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;


-- >>>>>>>>>> 2026_10_accounts_activation.sql
-- ==============================================================================
-- AgentShield 1.3 - Accounts, invites, activation codes and device authorization
--
-- Run once in the Supabase SQL Editor on an existing database, AFTER
-- 2026_10_enterprise_features.sql. Safe to run more than once.
-- The backend also creates these on startup and enables Row Level Security on
-- PostgreSQL automatically; this file lets you apply and verify it explicitly.
--
-- After this release, browsers enrolled with the old organization-wide codes
-- (device_keys) stop working until each user activates their browser.
-- ==============================================================================

-- Accounts: email verification and the EMPLOYEE role (role is a free-text column).
-- Accounts that existed before this release count as verified. Self-registered accounts
-- (which have a confirmation link) are left alone; this statement is placed after the
-- email_verifications table below.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP WITH TIME ZONE;

-- New browsers wait for admin approval when enabled
ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS require_device_approval BOOLEAN DEFAULT FALSE;

-- Email invitations (only the SHA-256 of the link token is stored)
CREATE TABLE IF NOT EXISTS user_invites (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'EMPLOYEE',
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    accepted_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_invites_org ON user_invites(organization_id);
CREATE INDEX IF NOT EXISTS idx_user_invites_email ON user_invites(email);

-- Email confirmation links for self sign-up (only the SHA-256 of the link token is stored)
CREATE TABLE IF NOT EXISTS email_verifications (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);

UPDATE users SET email_verified_at = created_at
WHERE email_verified_at IS NULL AND id NOT IN (SELECT user_id FROM email_verifications);

-- Single-use browser activation codes (only the SHA-256 is stored)
CREATE TABLE IF NOT EXISTS activation_tokens (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    token_prefix VARCHAR(16) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activation_tokens_user ON activation_tokens(user_id);

-- Authorized browsers (public key only; the private key never leaves the browser)
CREATE TABLE IF NOT EXISTS devices (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    browser VARCHAR(120),
    platform VARCHAR(60),
    activation_token_id VARCHAR(36),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    approved_by VARCHAR(255),
    last_seen_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    revoked_by VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS idx_devices_org ON devices(organization_id);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- Close the Supabase REST path for the new tables (the backend connects as owner)
ALTER TABLE user_invites      ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE activation_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices           ENABLE ROW LEVEL SECURITY;


-- >>>>>>>>>> 2026_10_saas_phase1.sql
-- ==============================================================================
-- AgentShield 1.4 - SaaS phase 1: companies, free trial, licences, plans, releases,
-- reminders, password reset and session revocation.
--
-- Run once in the Supabase SQL Editor AFTER 2026_10_accounts_activation.sql.
-- Safe to run more than once. The backend also creates these tables on startup,
-- seeds the plans, makes INITIAL_ADMIN_EMAIL the platform operator (SUPERADMIN)
-- and gives its own company a non-expiring "internal" licence.
-- ==============================================================================

ALTER TABLE organizations       ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE organizations       ADD COLUMN IF NOT EXISTS suspended_reason VARCHAR(255);
ALTER TABLE users               ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS purpose VARCHAR(10) NOT NULL DEFAULT 'verify';

-- Plans (prices are set by the platform admin in the portal; NULL = not for sale yet)
CREATE TABLE IF NOT EXISTS plans (
    code VARCHAR(30) PRIMARY KEY,
    name VARCHAR(80) NOT NULL,
    kind VARCHAR(10) NOT NULL,
    duration_days INTEGER,
    duration_months INTEGER,
    device_limit INTEGER NOT NULL DEFAULT 3,
    price_minor INTEGER,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    billing VARCHAR(20) NOT NULL DEFAULT 'one_time',
    features TEXT,
    purchasable BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    sort INTEGER DEFAULT 0,
    updated_by VARCHAR(255),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Licences: validity is decided from starts_at/expires_at against server time
CREATE TABLE IF NOT EXISTS licenses (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    plan_code VARCHAR(30) NOT NULL,
    kind VARCHAR(10) NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
    starts_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    device_limit INTEGER NOT NULL DEFAULT 3,
    payment_ref VARCHAR(120),
    created_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    revoked_at TIMESTAMP WITH TIME ZONE,
    revoked_by VARCHAR(255),
    revoked_reason VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS ix_licenses_org_expires ON licenses(organization_id, expires_at);

-- One free trial per company and per normalized email (unique constraints stop double claims)
CREATE TABLE IF NOT EXISTS trial_claims (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    user_id VARCHAR(36) NOT NULL,
    email_normalized VARCHAR(255) NOT NULL UNIQUE,
    email_domain VARCHAR(255) NOT NULL,
    ip_hash VARCHAR(64),
    license_id VARCHAR(36),
    claimed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_trial_claims_domain ON trial_claims(email_domain);
CREATE INDEX IF NOT EXISTS ix_trial_claims_ip ON trial_claims(ip_hash);
CREATE INDEX IF NOT EXISTS ix_trial_claims_claimed ON trial_claims(claimed_at);

-- Every manual licence change, with a reason
CREATE TABLE IF NOT EXISTS license_adjustments (
    id VARCHAR(36) PRIMARY KEY,
    license_id VARCHAR(36) NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
    old_expires_at TIMESTAMP WITH TIME ZONE,
    new_expires_at TIMESTAMP WITH TIME ZONE,
    reason VARCHAR(500) NOT NULL,
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_license_adjustments_license ON license_adjustments(license_id);

-- Reminders (UNIQUE(license_id, kind) keeps them idempotent)
CREATE TABLE IF NOT EXISTS notifications (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    license_id VARCHAR(36),
    kind VARCHAR(40) NOT NULL,
    title VARCHAR(200) NOT NULL,
    body TEXT,
    emailed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    read_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT uq_notifications_license_kind UNIQUE (license_id, kind)
);
CREATE INDEX IF NOT EXISTS ix_notifications_org ON notifications(organization_id);

-- Extension releases shown on the download page
CREATE TABLE IF NOT EXISTS extension_releases (
    id VARCHAR(36) PRIMARY KEY,
    version VARCHAR(30) NOT NULL UNIQUE,
    notes TEXT,
    sha256 VARCHAR(64),
    size_bytes INTEGER,
    min_chrome VARCHAR(10) DEFAULT '110',
    min_edge VARCHAR(10) DEFAULT '110',
    is_current BOOLEAN DEFAULT FALSE,
    published_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    published_by VARCHAR(255)
);

-- Close the Supabase REST path for the new tables (the backend connects as owner)
ALTER TABLE plans               ENABLE ROW LEVEL SECURITY;
ALTER TABLE licenses            ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial_claims        ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_releases  ENABLE ROW LEVEL SECURITY;


-- >>>>>>>>>> 2026_10_saas_phase2.sql
-- ==============================================================================
-- AgentShield 1.5 - SaaS phase 2: Razorpay payments, orders, subscriptions,
-- refunds/disputes and webhook idempotency.
--
-- Run once in the Supabase SQL Editor AFTER 2026_10_saas_phase1.sql.
-- Safe to run more than once. The backend also creates these tables on startup.
-- No card or UPI details are stored: Razorpay's hosted Checkout collects them.
-- ==============================================================================

ALTER TABLE plans ADD COLUMN IF NOT EXISTS razorpay_plan_id VARCHAR(60);
ALTER TABLE plans ADD COLUMN IF NOT EXISTS razorpay_plan_amount INTEGER;

-- Purchase attempts; "paid" only after Razorpay confirms the payment
CREATE TABLE IF NOT EXISTS billing_orders (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id VARCHAR(36),
    plan_code VARCHAR(30) NOT NULL,
    kind VARCHAR(15) NOT NULL,
    amount_minor INTEGER NOT NULL,
    currency VARCHAR(3) NOT NULL,
    provider VARCHAR(20) NOT NULL DEFAULT 'razorpay',
    provider_order_id VARCHAR(60) UNIQUE,
    provider_subscription_id VARCHAR(60),
    status VARCHAR(20) NOT NULL DEFAULT 'created',
    failure_reason VARCHAR(255),
    receipt_number VARCHAR(30) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    paid_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_billing_orders_org ON billing_orders(organization_id);
CREATE INDEX IF NOT EXISTS ix_billing_orders_sub ON billing_orders(provider_subscription_id);
CREATE INDEX IF NOT EXISTS ix_billing_orders_created ON billing_orders(created_at);

-- Captured payments (UNIQUE provider_payment_id: one payment grants one licence)
CREATE TABLE IF NOT EXISTS billing_payments (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    order_id VARCHAR(36) REFERENCES billing_orders(id) ON DELETE SET NULL,
    provider_payment_id VARCHAR(60) NOT NULL UNIQUE,
    amount_minor INTEGER NOT NULL,
    currency VARCHAR(3) NOT NULL,
    method VARCHAR(30),
    status VARCHAR(20) NOT NULL DEFAULT 'captured',
    refunded_minor INTEGER NOT NULL DEFAULT 0,
    license_id VARCHAR(36),
    receipt_number VARCHAR(30) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_billing_payments_org ON billing_payments(organization_id);
CREATE INDEX IF NOT EXISTS ix_billing_payments_order ON billing_payments(order_id);

-- Monthly recurring subscriptions
CREATE TABLE IF NOT EXISTS billing_subscriptions (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    plan_code VARCHAR(30) NOT NULL,
    provider_subscription_id VARCHAR(60) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'created',
    cancel_at_period_end BOOLEAN DEFAULT FALSE,
    current_end TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_billing_subscriptions_org ON billing_subscriptions(organization_id);

-- Every webhook received (UNIQUE event id: each event is applied once)
CREATE TABLE IF NOT EXISTS webhook_events (
    id VARCHAR(36) PRIMARY KEY,
    provider VARCHAR(20) NOT NULL DEFAULT 'razorpay',
    provider_event_id VARCHAR(80) NOT NULL UNIQUE,
    event VARCHAR(60) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'received',
    error VARCHAR(500),
    received_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS ix_webhook_events_received ON webhook_events(received_at);

ALTER TABLE billing_orders        ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_payments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events        ENABLE ROW LEVEL SECURITY;


-- >>>>>>>>>> 2026_10_internal_console.sql
-- ==============================================================================
-- AgentShieldAI 2.0 - Internal admin console (Phase A): staff accounts with
-- mandatory MFA, staff invites and recovery codes, audit actor types.
--
-- Run once in the Supabase SQL Editor AFTER 2026_10_saas_phase2.sql.
-- Safe to run more than once. The backend also creates these tables on startup.
-- Create the first platform owner afterwards with:
--     python -m app.cli create-platform-owner --email you@yourcompany.com
-- (no credentials are stored in this file or in the application source).
-- ==============================================================================

ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS actor_type VARCHAR(10) DEFAULT 'customer';

-- Platform administration moved from customer accounts to staff accounts
UPDATE users SET role = 'ADMIN' WHERE role = 'SUPERADMIN';

CREATE TABLE IF NOT EXISTS staff_users (
    id VARCHAR(36) PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(120),
    password_hash VARCHAR(255),
    role VARCHAR(30) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    totp_secret_enc TEXT,
    totp_enabled_at TIMESTAMP WITH TIME ZONE,
    totp_last_step INTEGER,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    session_version INTEGER NOT NULL DEFAULT 0,
    last_login_at TIMESTAMP WITH TIME ZONE,
    created_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT ck_staff_role CHECK (role IN ('PLATFORM_OWNER', 'PLATFORM_ADMIN', 'SECURITY_ANALYST',
                                             'SUPPORT_AGENT', 'BILLING_ADMIN', 'READONLY_ANALYST'))
);

CREATE TABLE IF NOT EXISTS staff_recovery_codes (
    id VARCHAR(36) PRIMARY KEY,
    staff_id VARCHAR(36) NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
    code_hash VARCHAR(255) NOT NULL,
    used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_staff_recovery_codes_staff ON staff_recovery_codes(staff_id);

CREATE TABLE IF NOT EXISTS staff_invites (
    id VARCHAR(36) PRIMARY KEY,
    staff_id VARCHAR(36) NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    accepted_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_staff_invites_staff ON staff_invites(staff_id);

CREATE INDEX IF NOT EXISTS ix_admin_audit_log_actor_type ON admin_audit_log(actor_type);

ALTER TABLE staff_users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_invites        ENABLE ROW LEVEL SECURITY;


-- >>>>>>>>>> 2026_10_individual_launch.sql
-- ==============================================================================
-- AgentShieldAI 2.1 - Individual launch: account types (Company "coming soon"),
-- usage metering (prompt checks), prepaid credits and limits, personal API tokens.
--
-- Run once in the Supabase SQL Editor AFTER 2026_10_internal_console.sql.
-- Safe to run more than once. The backend also creates these tables on startup.
-- ==============================================================================

-- Accounts: existing tenants stay COMPANY workspaces; public sign-up creates INDIVIDUAL accounts
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS account_type VARCHAR(12) NOT NULL DEFAULT 'COMPANY';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS credit_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS monthly_check_cap INTEGER;
ALTER TABLE users         ADD COLUMN IF NOT EXISTS display_name VARCHAR(120);
DO $$ BEGIN
    ALTER TABLE organizations ADD CONSTRAINT ck_org_account_type CHECK (account_type IN ('INDIVIDUAL', 'COMPANY'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
    ALTER TABLE organizations ADD CONSTRAINT ck_org_credit_balance CHECK (credit_balance >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Plans: prepaid credit packs (kind CREDITS) and monthly included prompt checks
ALTER TABLE plans ADD COLUMN IF NOT EXISTS credits INTEGER;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS check_limit INTEGER;

-- Metering idempotency: one stored event per extension event id
ALTER TABLE security_events ADD COLUMN IF NOT EXISTS client_event_id VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_client_event ON security_events (organization_id, client_event_id);

-- Metered usage per account, person and UTC day
CREATE TABLE IF NOT EXISTS usage_daily (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_email VARCHAR(255) NOT NULL DEFAULT '',
    day VARCHAR(10) NOT NULL,
    prompt_checks INTEGER NOT NULL DEFAULT 0,
    credit_checks INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    warned INTEGER NOT NULL DEFAULT 0,
    redacted INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT uq_usage_daily UNIQUE (organization_id, user_email, day)
);
CREATE INDEX IF NOT EXISTS ix_usage_daily_org_day ON usage_daily(organization_id, day);

-- Every credit balance change except per-prompt usage
CREATE TABLE IF NOT EXISTS credit_ledger (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    delta INTEGER NOT NULL,
    kind VARCHAR(20) NOT NULL,
    reference VARCHAR(120),
    note VARCHAR(255),
    balance_after INTEGER,
    created_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_credit_ledger_org ON credit_ledger(organization_id);
CREATE INDEX IF NOT EXISTS ix_credit_ledger_created ON credit_ledger(created_at);
CREATE INDEX IF NOT EXISTS ix_credit_ledger_reference ON credit_ledger(reference);

-- Personal API tokens (only SHA-256 hashes are stored)
CREATE TABLE IF NOT EXISTS api_tokens (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(80) NOT NULL,
    token_prefix VARCHAR(16) NOT NULL,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    scopes VARCHAR(120) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_api_tokens_org ON api_tokens(organization_id);
CREATE INDEX IF NOT EXISTS ix_api_tokens_user ON api_tokens(user_id);

-- Credit pack (price unset: set it in the internal console before selling)
INSERT INTO plans (code, name, kind, device_limit, currency, billing, features, purchasable, active, sort, credits, updated_by)
VALUES ('credits_1000', '1,000 prompt checks', 'CREDITS', 3, 'INR', 'one_time',
        '["Pay only for what you use", "Credits never expire", "Up to 3 browsers"]', FALSE, TRUE, 5, 1000, 'migration')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE usage_daily   ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tokens    ENABLE ROW LEVEL SECURITY;


-- >>>>>>>>>> 2026_10_web_categories.sql
-- ==============================================================================
-- AgentShieldAI 2.2 - Category web filtering (adult, piracy, malware, gambling, ...)
-- and Safe Search enforcement.
--
-- Run once in the Supabase SQL Editor AFTER 2026_10_individual_launch.sql.
-- Safe to run more than once. The backend also adds these columns on startup.
-- ==============================================================================

-- JSON {"adult": true, "piracy": true, ...}; NULL or missing keys = the catalog defaults
ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS web_categories TEXT;
-- Safe Search / YouTube Restricted Mode; NULL = follow the "adult" category
ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS safe_search BOOLEAN;


-- >>>>>>>>>> 2026_10_free_tier.sql
-- ==============================================================================
-- AgentShieldAI 2.3 - Free forever for individual accounts, and referrals.
--
-- Run once in the Supabase SQL Editor AFTER 2026_10_web_categories.sql.
-- Safe to run more than once. The backend also adds these on startup.
-- ==============================================================================

-- Invite links (#ref=<code>): random code per account, created on first use
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS referral_code VARCHAR(16);
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_referral_code ON organizations (referral_code);

-- One row per account that signed up from an invite; rewarded when its email is confirmed
CREATE TABLE IF NOT EXISTS referrals (
    id VARCHAR(36) PRIMARY KEY,
    referrer_org_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    referred_org_id VARCHAR(36) NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    status VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    rewarded_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS ix_referrals_referrer_org_id ON referrals(referrer_org_id);
DO $$ BEGIN
    ALTER TABLE referrals ADD CONSTRAINT ck_referral_status CHECK (status IN ('PENDING', 'REWARDED', 'NOT_REWARDED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The Free plan (computed entitlement, never a licence, never sold). Edit its monthly prompt checks
-- and browser limit in the internal console -> Plans & pricing.
INSERT INTO plans (code, name, kind, device_limit, currency, billing, features, purchasable, active, sort, check_limit, updated_by)
VALUES ('free', 'Free', 'FREE', 1, 'INR', 'one_time',
        '["300 prompt checks every month", "1 browser", "Website controls and category blocking"]', FALSE, TRUE, -1, 300, 'migration')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;


-- >>>>>>>>>> 2026_10_windows_app.sql
-- ==============================================================================
-- AgentShieldAI 2.4 - AgentShield Windows app: connect a PC once for all its browsers.
--
-- Run once in the Supabase SQL Editor AFTER 2026_10_free_tier.sql.
-- Safe to run more than once. The backend also adds these on startup.
-- ==============================================================================

-- PCs connected through the AgentShield Windows app (one device slot each, whatever the number of browsers)
CREATE TABLE IF NOT EXISTS computers (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(120),
    platform VARCHAR(60),
    public_key TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    activation_token_id VARCHAR(36),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    revoked_by VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS ix_computers_organization_id ON computers(organization_id);
CREATE INDEX IF NOT EXISTS ix_computers_user_id ON computers(user_id);

-- Browsers connected through a PC, and the single-use codes a PC made for them
ALTER TABLE devices ADD COLUMN IF NOT EXISTS computer_id VARCHAR(36);
CREATE INDEX IF NOT EXISTS ix_devices_computer_id ON devices(computer_id);
ALTER TABLE activation_tokens ADD COLUMN IF NOT EXISTS computer_id VARCHAR(36);
CREATE INDEX IF NOT EXISTS ix_activation_tokens_computer_id ON activation_tokens(computer_id);

ALTER TABLE computers ENABLE ROW LEVEL SECURITY;


-- >>>>>>>>>> 2026_10_free_claim.sql
-- AgentShieldAI 2.3.2 - The Free plan is chosen, not automatic
-- Run after 2026_10_free_tier.sql. Safe to run more than once; the backend also adds the column on start.
--
-- organizations.free_started_at: set when the account clicks "Start Free plan" (POST /api/v1/billing/free).
-- Until an account chooses the Free plan, the trial, a paid plan or credits it has no access (no download,
-- no activation code). Accounts that already had a trial or paid plan move to the Free plan when it ends.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS free_started_at TIMESTAMP WITH TIME ZONE;



-- >>>>>>>>>> 2026_10_policy_revision.sql
-- ==============================================================================
-- AgentShieldAI 2.6 - Near real-time rule sync
-- Run after 2026_10_free_claim.sql. Safe to run more than once; the backend also adds the column on start.
--
-- organizations.policy_revision: increased by every change the browsers enforce (protection rules,
-- website categories, Safe Search, website rules, keywords, settings). Each browser checks it once a
-- minute (GET /api/v1/policies/revision) and downloads the full rules only when it changed.
-- ==============================================================================

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS policy_revision INTEGER NOT NULL DEFAULT 1;
