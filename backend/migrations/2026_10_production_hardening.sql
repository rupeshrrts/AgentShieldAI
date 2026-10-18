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
