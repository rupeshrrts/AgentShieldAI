-- AgentShieldAI 2.3.2 - The Free plan is chosen, not automatic
-- Run after 2026_10_free_tier.sql. Safe to run more than once; the backend also adds the column on start.
--
-- organizations.free_started_at: set when the account clicks "Start Free plan" (POST /api/v1/billing/free).
-- Until an account chooses the Free plan, the trial, a paid plan or credits it has no access (no download,
-- no activation code). Accounts that already had a trial or paid plan move to the Free plan when it ends.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS free_started_at TIMESTAMP WITH TIME ZONE;
