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
