/**
 * Shared TypeScript types for AgentShield Chrome Extension
 */

export type PolicyAction = 'ALLOW' | 'MONITOR' | 'WARN' | 'BLOCK' | 'REDACT';
export type SeverityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Finding {
  rule_id: string;
  category: 'SECRET' | 'PII' | 'RESTRICTED';
  severity: SeverityLevel;
  start: number;
  end: number;
  matched_value?: string; // used locally only; NEVER sent to audit backend
}

export interface PolicyRule {
  id: string;
  rule_id: string;
  category: string;
  name: string;
  site_scope?: string;
  action: PolicyAction;
  severity: SeverityLevel;
  enabled: boolean;
  version: number;
}

export interface PolicyEvaluationResult {
  action: PolicyAction;
  primary_rule_id: string | null;
  highest_severity: SeverityLevel | null;
  reason: string;
  findings: Finding[];
  needs_confirmation: boolean;
  redacted_text?: string;
}

export interface SecurityEventPayload {
  site: string;
  rule_id: string;
  category: string;
  severity: SeverityLevel;
  action: PolicyAction;
  /** e.g. blocked, warned_and_confirmed, warned_and_cancelled, redacted_and_submitted, monitored,
   *  allowed, navigation_blocked, file_blocked, file_warned_and_confirmed, file_monitored */
  outcome: string;
  user_id?: string;
  /** Already secret-masked text; omitted when the organization's privacy settings say not to store it. */
  prompt?: string;
  /** Reason the employee typed when proceeding past a warning. */
  justification?: string;
  extension_version?: string;
  policy_version?: number;
}

/** Settings managed from the dashboard and synced to the extension. */
export interface ExtensionSettings {
  store_clean_prompt_text: boolean;
  store_violation_prompt_text: boolean;
  block_unapproved_ai: boolean;
  /** Website categories to block ({"adult": true, ...}); missing = safe defaults (shared/web-categories.ts). */
  web_categories?: Record<string, boolean>;
  /** Safe Search / YouTube Restricted Mode; missing = follows the adult category. */
  safe_search?: boolean;
}

/**
 * Server addresses supplied by enterprise policy or the installer. They carry no credential:
 * every browser is authorized only by activating it with a signed-in account.
 */
export interface ClientConfig {
  apiUrl?: string;
  dashboardUrl?: string;
}

/**
 * Activation and licence state machine (see background/auth-state.ts).
 * LOCKED -> CONNECTING -> AUTHENTICATING -> TRIAL_ACTIVE | SUBSCRIPTION_ACTIVE | FREE_ACTIVE | FREE_PAUSED,
 * with failure states. FREE_PAUSED is connected (AI sites usable, website controls on) but prompt checks pause.
 */
export type AuthStateName =
  | 'LOCKED'
  | 'CONNECTING'
  | 'AUTHENTICATING'
  | 'TRIAL_ACTIVE'
  | 'SUBSCRIPTION_ACTIVE'
  | 'FREE_ACTIVE'
  | 'FREE_PAUSED'
  | 'PENDING_APPROVAL'
  | 'CONNECTION_ERROR'
  | 'INVALID_TOKEN'
  | 'EXPIRED'
  | 'REVOKED';

export interface DomainRule {
  id: string;
  organization_id?: string;
  domain: string;
  action: 'BLOCK' | 'ALLOW';
  category?: string;
  description?: string;
  enabled: boolean;
}

export interface ExtensionSyncState {
  is_active: boolean;
  is_online: boolean;
  policy_version: number;
  last_synced_at: string;
  organization_id: string;
  organization_name: string;
  user_id?: string;
  policies: PolicyRule[];
  /** Undefined until the first successful sync; then the dashboard-managed list (possibly empty). */
  keywords?: string[];
  settings: ExtensionSettings;
  /** Known generative-AI domains (from the backend), used when block_unapproved_ai is on. */
  ai_domains?: string[];
  domain_rules?: DomainRule[];
  blocked_domains?: string[];
  allowed_domains?: string[];
  /** Activation/licence state. Only TRIAL_ACTIVE, SUBSCRIPTION_ACTIVE, FREE_ACTIVE or FREE_PAUSED with a live, server-issued session unlocks AI sites. */
  auth_state: AuthStateName;
  /** Explanation of the current state and the next step, shown in the popup. */
  auth_message?: string;
  /** Account this browser is activated for (from the server). */
  user_email?: string;
  /** Last sync error, shown in the popup. */
  last_error?: string;
}

