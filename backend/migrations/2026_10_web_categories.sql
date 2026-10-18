-- ==============================================================================
-- AgentShieldAI 2.2 - Category web filtering (adult, piracy, malware, gambling, ...)
-- and Safe Search enforcement.
--
-- Run once in the Supabase SQL Editor AFTER 2026_10_individual_launch.sql.
-- Safe to run more than once. The backend also adds these columns on startup.
-- ==============================================================================

-- JSON {"adult": true, "piracy": true, ...}; NULL or missing keys = the catalog defaults
ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS web_categories TEXT;
-- Safe Search / YouTube Restricted Mode; NULL = follow the "adult" category
ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS safe_search BOOLEAN;
