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
