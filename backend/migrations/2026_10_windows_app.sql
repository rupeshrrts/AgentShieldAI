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
