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
