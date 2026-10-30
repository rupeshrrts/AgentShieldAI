-- ==============================================================================
-- AgentShieldAI 2.6 - Near real-time rule sync
-- Run after 2026_10_free_claim.sql. Safe to run more than once; the backend also adds the column on start.
--
-- organizations.policy_revision: increased by every change the browsers enforce (protection rules,
-- website categories, Safe Search, website rules, keywords, settings). Each browser checks it once a
-- minute (GET /api/v1/policies/revision) and downloads the full rules only when it changed.
-- ==============================================================================

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS policy_revision INTEGER NOT NULL DEFAULT 1;
