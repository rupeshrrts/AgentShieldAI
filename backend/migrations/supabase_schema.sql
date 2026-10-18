-- ==============================================================================
-- AgentShield - Supabase PostgreSQL Schema & Initial Seeder
-- Run this script directly in your Supabase SQL Editor (SQL Editor -> New Query -> Run)
-- ==============================================================================

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Organizations Table (Tenant Isolation)
CREATE TABLE IF NOT EXISTS organizations (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    retention_days INTEGER DEFAULT 30,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Users Table (Identity and Role-Based Access Control)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'ADMIN', -- ADMIN, VIEWER
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 3. Policies Table (Organization Governance Rules)
CREATE TABLE IF NOT EXISTS policies (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    rule_id VARCHAR(80) NOT NULL,
    category VARCHAR(50) NOT NULL,  -- SECRET, PII, RESTRICTED
    site_scope VARCHAR(255) DEFAULT '*', -- chatgpt.com or *
    action VARCHAR(20) NOT NULL DEFAULT 'BLOCK', -- ALLOW, WARN, BLOCK, REDACT
    severity VARCHAR(20) NOT NULL DEFAULT 'HIGH', -- LOW, MEDIUM, HIGH, CRITICAL
    enabled BOOLEAN DEFAULT TRUE,
    version INTEGER DEFAULT 1,
    updated_by VARCHAR(100) DEFAULT 'system',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_policies_org ON policies(organization_id);
CREATE INDEX IF NOT EXISTS idx_policies_rule ON policies(rule_id);

-- 4. Security Events Table (Data Minimization: NO RAW PROMPTS)
CREATE TABLE IF NOT EXISTS security_events (
    id VARCHAR(36) PRIMARY KEY,
    organization_id VARCHAR(36) NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id VARCHAR(100),
    occurred_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    site VARCHAR(120) NOT NULL,
    rule_id VARCHAR(80) NOT NULL,
    category VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL,
    action VARCHAR(20) NOT NULL,
    outcome VARCHAR(50) NOT NULL,
    extension_version VARCHAR(30) DEFAULT '1.0.0',
    policy_version INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_events_org_occurred ON security_events(organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_rule ON security_events(rule_id);

-- ==============================================================================
-- Initial Demo Seeder (Idempotent: Safe to re-run multiple times)
-- ==============================================================================

-- Seed Demo Organization
INSERT INTO organizations (id, name, retention_days, created_at)
VALUES ('org-acme-corp-001', 'Acme Corp', 30, NOW())
ON CONFLICT (id) DO NOTHING;

-- Seed Demo Admin User (Password: AdminShield2026!)
-- Hash: pbkdf2:sha256:100000$8792eb321e1882fc9b2cbe675952f400$5fb8230df8ad33a25b29b9f7a778c1cfa28639a04a377dcb2c9f972fb092ae89
INSERT INTO users (id, organization_id, email, password_hash, role, active, created_at)
VALUES (
    'usr-admin-001',
    'org-acme-corp-001',
    'admin@agentshield.local',
    'pbkdf2:sha256:100000$8792eb321e1882fc9b2cbe675952f400$5fb8230df8ad33a25b29b9f7a778c1cfa28639a04a377dcb2c9f972fb092ae89',
    'ADMIN',
    TRUE,
    NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Seed Default Security Policies
INSERT INTO policies (id, organization_id, name, rule_id, category, site_scope, action, severity, enabled, version, updated_by)
VALUES 
    ('pol-secret-api-key', 'org-acme-corp-001', 'Block API Keys & Credentials', 'secret.api_key_like', 'SECRET', '*', 'BLOCK', 'HIGH', TRUE, 1, 'admin@agentshield.local'),
    ('pol-pii-email', 'org-acme-corp-001', 'Warn on Customer & Employee Emails', 'pii.email', 'PII', '*', 'WARN', 'MEDIUM', TRUE, 1, 'admin@agentshield.local'),
    ('pol-pii-phone', 'org-acme-corp-001', 'Warn on Contact Phone Numbers', 'pii.phone', 'PII', '*', 'WARN', 'LOW', TRUE, 1, 'admin@agentshield.local'),
    ('pol-restricted-keywords', 'org-acme-corp-001', 'Redact Confidential Project Codewords', 'restricted.keyword', 'RESTRICTED', '*', 'REDACT', 'HIGH', TRUE, 1, 'admin@agentshield.local')
ON CONFLICT (id) DO NOTHING;
