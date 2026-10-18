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
