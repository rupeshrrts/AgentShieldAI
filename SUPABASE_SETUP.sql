-- ==============================================================================
-- WARNING - LOCAL TESTING ONLY - DO NOT USE AS-IS IN PRODUCTION
--
-- Section 5 below inserts DEMO ACCOUNTS WITH PUBLISHED PASSWORDS
-- (admin@agentshield.local and auditor@agentshield.local; the passwords are
-- printed in this file and in older public releases), plus a demo company,
-- demo policies and demo security events. Anyone who has read this repository
-- can sign in with them. Use this seed only on a local or throwaway test
-- database. For production, do not run section 5 (or delete those accounts
-- immediately afterwards).
--
-- Since 2.0 the application itself no longer creates any default accounts:
-- there is no default admin and no default SECRET_KEY. The first customer company
-- and its admin are created only when INITIAL_ADMIN_EMAIL and
-- INITIAL_ADMIN_PASSWORD are both set; the read-only demo auditor only when
-- DEMO_AUDITOR_PASSWORD is set (never in production); internal staff only with
--     python -m app.cli create-platform-owner --email you@yourcompany.com
-- The 2.0 backend refuses these published passwords as new passwords and flags
-- accounts that still use one. This file also predates later schema changes:
-- the backend creates newer tables and columns at startup, and existing
-- databases are upgraded with backend/migrations/*.sql (run in order, ending
-- with 2026_10_internal_console.sql).
-- ==============================================================================

-- ==============================================================================
-- AGENTSHIELD - COMPLETE SUPABASE POSTGRESQL SCHEMA & INITIAL SEEDER
--
-- Instructions:
-- 1. Open your Supabase Dashboard: https://supabase.com
-- 2. Select your project -> Click on "SQL Editor" on the left sidebar.
-- 3. Click "New Query".
-- 4. Paste this ENTIRE file into the editor.
-- 5. Click "Run" (or Ctrl + Enter).
-- ==============================================================================

-- Enable UUID extension if not already present
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==============================================================================
-- 1. TABLE: ORGANIZATIONS (Multi-Tenant Isolation)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS organizations (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    retention_days INTEGER DEFAULT 30,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ==============================================================================
-- 2. TABLE: USERS (Identity & Role-Based Access Control)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'ADMIN', -- Roles: ADMIN, VIEWER
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ==============================================================================
-- 3. TABLE: POLICIES (Governance & DLP Rules Enforced by Browser Extension)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS policies (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    rule_id VARCHAR(80) NOT NULL,
    category VARCHAR(50) NOT NULL,               -- 'SECRET', 'PII', 'RESTRICTED'
    site_scope VARCHAR(255) DEFAULT '*',         -- '*' or specific host like 'chatgpt.com'
    action VARCHAR(20) NOT NULL DEFAULT 'BLOCK', -- 'ALLOW', 'WARN', 'BLOCK', 'REDACT'
    severity VARCHAR(20) NOT NULL DEFAULT 'HIGH',-- 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'
    enabled BOOLEAN DEFAULT TRUE,
    version INTEGER DEFAULT 1,
    updated_by VARCHAR(100) DEFAULT 'system',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_policies_org ON policies(organization_id);
CREATE INDEX IF NOT EXISTS idx_policies_rule ON policies(rule_id);

-- ==============================================================================
-- 4. TABLE: SECURITY_EVENTS (Privacy-Conscious Audit Log)
-- CRITICAL PRIVACY RULE: NEVER STORES RAW PROMPTS OR CREDENTIALS
-- ==============================================================================
CREATE TABLE IF NOT EXISTS security_events (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id VARCHAR(100),                        -- Pseudonymous client or employee ID
    occurred_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    site VARCHAR(120) NOT NULL,                  -- Target site (e.g., 'chatgpt.com')
    rule_id VARCHAR(80) NOT NULL,                -- Rule matched (e.g., 'secret.api_key_like')
    category VARCHAR(50) NOT NULL,               -- 'SECRET', 'PII', 'RESTRICTED'
    severity VARCHAR(20) NOT NULL,               -- 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'
    action VARCHAR(20) NOT NULL,                 -- Action applied: 'BLOCK', 'WARN', 'REDACT', 'ALLOW'
    outcome VARCHAR(50) NOT NULL,                -- 'blocked', 'warned_and_confirmed', 'redacted', 'allowed'
    extension_version VARCHAR(30) DEFAULT '1.0.0',
    policy_version INTEGER DEFAULT 1,
    prompt TEXT,                                 -- Stored prompt for audit verification & analysis
    prompt_preview TEXT,
    department VARCHAR(100) DEFAULT 'Engineering',
    application VARCHAR(100) DEFAULT 'ChatGPT',
    dlp_engine VARCHAR(100) DEFAULT '-',
    location VARCHAR(100) DEFAULT 'Bangalore'
);

CREATE INDEX IF NOT EXISTS idx_events_org_occurred ON security_events(organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_rule ON security_events(rule_id);
CREATE INDEX IF NOT EXISTS idx_events_user ON security_events(user_id);

-- ==============================================================================
-- 5. TABLE: DOMAIN_RULES (Domain Traffic Controls - Blocked vs Allowed)
-- ==============================================================================
CREATE TABLE IF NOT EXISTS domain_rules (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    domain VARCHAR(255) NOT NULL,
    action VARCHAR(20) NOT NULL DEFAULT 'BLOCK', -- 'BLOCK', 'ALLOW'
    category VARCHAR(100) DEFAULT 'File Converter / Shadow AI',
    description VARCHAR(255),
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_domain_rules_org ON domain_rules(organization_id);
CREATE INDEX IF NOT EXISTS idx_domain_rules_domain ON domain_rules(domain);

-- ==============================================================================
-- 6. TABLES: GOVERNANCE, DEVICE KEYS, KEYWORDS, SETTINGS
-- ==============================================================================
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
    block_unapproved_ai BOOLEAN DEFAULT FALSE,
    updated_by VARCHAR(255),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

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

ALTER TABLE security_events ADD COLUMN IF NOT EXISTS justification TEXT;

-- ==============================================================================
-- 7. ROW LEVEL SECURITY (required on Supabase)
-- Supabase exposes public tables through its REST API to anyone with the public
-- "anon" key. Enabling RLS with no policies closes that path. The AgentShield
-- backend connects as the table owner and is not affected.
-- ==============================================================================
ALTER TABLE organizations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies              ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_rules          ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_governance       ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_keys           ENABLE ROW LEVEL SECURITY;
ALTER TABLE restricted_keywords   ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE endpoints             ENABLE ROW LEVEL SECURITY;


-- ==============================================================================
-- 5. INITIAL SEED DATA (Idempotent: Safe to run multiple times)
-- ==============================================================================

-- A. Default Demo Organization: Acme Corp
INSERT INTO organizations (id, name, retention_days, created_at)
VALUES ('org-acme-corp-001', 'Acme Corp', 30, NOW())
ON CONFLICT (id) DO NOTHING;

-- B. Demo administrator (LOCAL TESTING ONLY, see the warning at the top): admin@agentshield.local
-- Password: AdminShield2026!  (published default: never use this account in
-- production; on a test database change it on the dashboard's
-- Deployment & Settings page right after first sign-in)
-- Hash generated with PBKDF2-HMAC-SHA256 (100,000 iterations)
-- Re-running this script never resets a password that was already changed.
INSERT INTO users (id, organization_id, email, password_hash, role, active, created_at)
VALUES (
    'usr-admin-001',
    'org-acme-corp-001',
    'admin@agentshield.local',
    'pbkdf2:sha256:100000$af145182b899c532b3f2e6a9c32f6ad0$90146bf5a412f1df20708b5ad1ff9b7fe1f734474f444da42ec0227874a2ea85',
    'ADMIN',
    TRUE,
    NOW()
)
ON CONFLICT (id) DO NOTHING;

-- C. Demo auditor (Viewer, LOCAL TESTING ONLY): auditor@agentshield.local
-- Password: Auditor2026!  (published default; the backend disables this account when ENVIRONMENT=production)
INSERT INTO users (id, organization_id, email, password_hash, role, active, created_at)
VALUES (
    'usr-viewer-001',
    'org-acme-corp-001',
    'auditor@agentshield.local',
    'pbkdf2:sha256:100000$f6808c7413b8545e8995e8311dbd8d78$c28884448db7d3464184823ab74417efa95a0f4caf1c88c15f14d54cebd10d1d',
    'VIEWER',
    TRUE,
    NOW()
)
ON CONFLICT (id) DO NOTHING;

-- D. Initial Organization Security Policies (from AgentShield POC specification)
INSERT INTO policies (id, organization_id, name, rule_id, category, site_scope, action, severity, enabled, version, updated_by)
VALUES 
    (
        'pol-secret-api-key',
        'org-acme-corp-001',
        'Block API Keys & Credentials',
        'secret.api_key_like',
        'SECRET',
        '*',
        'BLOCK',
        'HIGH',
        TRUE,
        1,
        'admin@agentshield.local'
    ),
    (
        'pol-pii-email',
        'org-acme-corp-001',
        'Warn on Customer & Employee Emails',
        'pii.email',
        'PII',
        '*',
        'WARN',
        'MEDIUM',
        TRUE,
        1,
        'admin@agentshield.local'
    ),
    (
        'pol-pii-phone',
        'org-acme-corp-001',
        'Warn on Contact Phone Numbers',
        'pii.phone',
        'PII',
        '*',
        'WARN',
        'LOW',
        TRUE,
        1,
        'admin@agentshield.local'
    ),
    (
        'pol-restricted-keywords',
        'org-acme-corp-001',
        'Redact Confidential Project Codewords',
        'restricted.keyword',
        'RESTRICTED',
        '*',
        'REDACT',
        'HIGH',
        TRUE,
        1,
        'admin@agentshield.local'
    )
ON CONFLICT (id) DO NOTHING;

-- E. Default Domain Traffic Policies (Blocked vs Allowed)
INSERT INTO domain_rules (id, organization_id, domain, action, category, description, enabled)
VALUES
    ('dom-001', 'org-acme-corp-001', 'ilovepdf.com', 'BLOCK', 'File Converter / Shadow AI', 'Public online PDF converter. High data exfiltration risk.', TRUE),
    ('dom-002', 'org-acme-corp-001', 'smallpdf.com', 'BLOCK', 'File Converter / Shadow AI', 'Third-party document processing cloud.', TRUE),
    ('dom-003', 'org-acme-corp-001', 'pastebin.com', 'BLOCK', 'Public Code / Paste Site', 'Public paste service. Potential source code leak target.', TRUE),
    ('dom-004', 'org-acme-corp-001', 'pdf2go.com', 'BLOCK', 'File Converter / Shadow AI', 'Unauthorized online document manipulation service.', TRUE),
    ('dom-005', 'org-acme-corp-001', 'wetransfer.com', 'BLOCK', 'Unsanctioned Cloud Transfer', 'Consumer file sharing platform.', TRUE),
    ('dom-006', 'org-acme-corp-001', 'chatgpt.com', 'ALLOW', 'Sanctioned GenAI Tool', 'Corporate approved OpenAI ChatGPT subscription workspace.', TRUE),
    ('dom-007', 'org-acme-corp-001', 'chat.openai.com', 'ALLOW', 'Sanctioned GenAI Tool', 'Corporate approved OpenAI interface.', TRUE),
    ('dom-008', 'org-acme-corp-001', 'claude.ai', 'ALLOW', 'Sanctioned GenAI Tool', 'Approved Anthropic Claude AI workspace.', TRUE),
    ('dom-009', 'org-acme-corp-001', 'gemini.google.com', 'ALLOW', 'Sanctioned GenAI Tool', 'Approved Google Gemini Workspace suite.', TRUE),
    ('dom-010', 'org-acme-corp-001', 'copilot.microsoft.com', 'ALLOW', 'Sanctioned GenAI Tool', 'Approved Microsoft Copilot Enterprise suite.', TRUE)
ON CONFLICT (id) DO NOTHING;

-- F. Initial Demo Audit Events for Dashboard Visualization
INSERT INTO security_events (id, organization_id, user_id, occurred_at, site, rule_id, category, severity, action, outcome, prompt, prompt_preview, extension_version, policy_version)
VALUES
    ('evt-demo-001', 'org-acme-corp-001', 'emp-anon-882', NOW() - INTERVAL '1 hour', 'chatgpt.com', 'secret.api_key_like', 'SECRET', 'HIGH', 'BLOCK', 'blocked', 'Explain this key: sk-test-0123456789abcdef', 'Explain this key: sk-test-0123456789abcdef', '1.0.0', 1),
    ('evt-demo-002', 'org-acme-corp-001', 'emp-anon-104', NOW() - INTERVAL '30 minutes', 'chatgpt.com', 'pii.email', 'PII', 'MEDIUM', 'WARN', 'warned_and_confirmed', 'Send email to demo.user@example.com for onboarding', 'Send email to demo.user@example.com for onboarding', '1.0.0', 1),
    ('evt-demo-003', 'org-acme-corp-001', 'emp-anon-391', NOW() - INTERVAL '10 minutes', 'chatgpt.com', 'restricted.keyword', 'RESTRICTED', 'HIGH', 'REDACT', 'redacted_and_submitted', 'Review draft for PROJECT-ALPHA-CONFIDENTIAL roadmap', 'Review draft for [REDACTED:RESTRICTED] roadmap', '1.0.0', 1),
    ('evt-demo-004', 'org-acme-corp-001', 'emp-user-101', NOW() - INTERVAL '5 minutes', 'chatgpt.com', 'general.clean_prompt', 'PROMPT_LOG', 'LOW', 'ALLOW', 'allowed', 'How do I optimize a PostgreSQL index query in SQLAlchemy?', 'How do I optimize a PostgreSQL index query in SQLAlchemy?', '1.0.0', 1)
ON CONFLICT (id) DO NOTHING;


-- ==============================================================================
-- Verification Check (Returns table status)
-- ==============================================================================
SELECT 'AgentShield database successfully initialized on Supabase!' AS status;
