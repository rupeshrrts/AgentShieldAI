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
