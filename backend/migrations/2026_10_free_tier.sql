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
