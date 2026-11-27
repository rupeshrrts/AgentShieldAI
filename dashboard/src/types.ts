export type PolicyAction = 'ALLOW' | 'MONITOR' | 'WARN' | 'BLOCK' | 'REDACT';
export type SeverityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface UserSession {
  token: string;
  user_id: string;
  email: string;
  role: string;
  organization_id: string;
  organization_name: string;
  /** INDIVIDUAL (personal account) or COMPANY (workspace; public sign-up is "coming soon") */
  account_type?: 'INDIVIDUAL' | 'COMPANY';
  email_verified?: boolean;
  /** Server setting: the Free plan and trial wait for a confirmed email (off by default) */
  email_verification_required?: boolean;
  display_name?: string | null;
}

export interface UsageDay {
  day: string;
  prompt_checks: number;
  credit_checks: number;
  blocked: number;
  warned: number;
  redacted: number;
}

export interface UsageSummary {
  period_days: number;
  month_start: string;
  entitlement: Entitlement;
  totals: Omit<UsageDay, 'day'>;
  daily: UsageDay[];
  unit: string;
}

export interface CreditLedgerEntry {
  delta: number;
  kind: string;
  note: string | null;
  balance_after: number | null;
  created_at: string | null;
}

export interface ApiTokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  state: 'active' | 'expired' | 'revoked';
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string | null;
}

export interface Policy {
  id: string;
  organization_id: string;
  name: string;
  rule_id: string;
  category: string;
  site_scope?: string;
  action: PolicyAction;
  severity: SeverityLevel;
  enabled: boolean;
  version: number;
  updated_by?: string;
  updated_at?: string;
  created_at?: string;
}

export interface SecurityEvent {
  id: string;
  organization_id: string;
  company_name?: string;
  user_id?: string;
  occurred_at: string;
  site: string;
  rule_id: string;
  category: string;
  severity: SeverityLevel;
  action: PolicyAction;
  outcome: string;
  extension_version: string;
  policy_version: number;
  department?: string;
  application?: string;
  prompt?: string;
  prompt_preview?: string;
  dlp_engine?: string;
  location?: string;
  justification?: string;
}

export interface DomainRule {
  id: string;
  organization_id: string;
  domain: string;
  action: 'BLOCK' | 'ALLOW';
  category?: string;
  description?: string;
  enabled: boolean;
  created_at?: string;
  updated_at?: string;
}


export interface CompanyBreakdownItem {
  organization_id: string;
  company_name: string;
  total_events: number;
  total_bad_requests: number;
  blocked_count: number;
  warned_count: number;
  redacted_count: number;
  allowed_count: number;
  top_violation_rule?: string;
  latest_violation_at?: string;
}

export interface MetricsSummary {
  total_events: number;
  blocked_count: number;
  warned_count: number;
  redacted_count: number;
  allowed_count: number;
  monitored_count?: number;
  events_last_24h?: number;
  active_policies_count: number;
  category_distribution: Record<string, number>;
  severity_distribution: Record<string, number>;
  site_distribution?: Record<string, number>;
  daily_events?: Array<{ day: string; blocked: number; warned: number; redacted: number; other: number }>;
  recent_events: SecurityEvent[];
  company_breakdown?: CompanyBreakdownItem[];
}

export interface EvaluationResult {
  action: PolicyAction;
  primary_rule_id: string | null;
  highest_severity: SeverityLevel | null;
  reason: string;
  needs_confirmation: boolean;
  findings_count: number;
  findings: Array<{
    rule_id: string;
    category: string;
    severity: string;
    start: number;
    end: number;
  }>;
  redacted_preview?: string;
}

export interface UserRiskSummary {
  user_id: string;
  department?: string;
  total_prompts: number;
  good_prompts: number;
  bad_prompts: number;
  blocked_count: number;
  warned_count: number;
  redacted_count: number;
  monitored_count?: number;
  blocked_sites_count?: number;
  status: 'ACTIVE' | 'WARNED' | 'RESTRICTED' | 'SUSPENDED';
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  notes?: string;
  action_taken_by?: string;
  latest_activity?: string;
}

export type AccountRole = 'ADMIN' | 'VIEWER' | 'EMPLOYEE';

export interface Account {
  id: string;
  email: string;
  role: AccountRole;
  active: boolean;
  email_verified_at?: string;
  created_at?: string;
  device_count: number;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: AccountRole;
  expires_at: string;
  created_by?: string;
  created_at?: string;
}

export interface InviteSent extends PendingInvite {
  delivery: 'smtp' | 'log';
}

export interface InviteInfo {
  email: string;
  organization_name: string;
  role: AccountRole;
  expires_at: string;
}

export interface AuthorizedDevice {
  id: string;
  user_id: string;
  user_email?: string;
  status: 'PENDING' | 'ACTIVE' | 'REVOKED';
  browser?: string;
  platform?: string;
  created_at?: string;
  approved_by?: string;
  last_seen_at?: string;
  revoked_at?: string;
  revoked_by?: string;
  /** Set when the browser was connected through the AgentShield Windows app (signed out with its PC) */
  computer_id?: string | null;
  computer_name?: string | null;
}

/** A PC connected once through the AgentShield Windows app; its browsers share one device slot. */
export interface ConnectedComputer {
  id: string;
  name?: string | null;
  platform?: string | null;
  status: 'ACTIVE' | 'REVOKED';
  created_at?: string;
  last_seen_at?: string;
  browsers: AuthorizedDevice[];
}

export interface ActivationTokenCreated {
  token: string;
  token_prefix: string;
  expires_at: string;
  api_url: string;
}

export interface RestrictedKeyword {
  id: string;
  keyword: string;
  created_by?: string;
  created_at?: string;
}

export interface OrgSettings {
  organization_id: string;
  organization_name: string;
  retention_days: number;
  block_passwords_and_secrets: boolean | null;
  credential_prefixes: string[];
  secret_protected_hosts: string[];
  store_clean_prompt_text: boolean;
  store_violation_prompt_text: boolean;
  block_unapproved_ai: boolean;
  require_device_approval: boolean;
  /** Website categories blocked by the extension ({ adult: true, ... }) */
  web_categories?: Record<string, boolean>;
  /** Safe Search / YouTube Restricted Mode */
  safe_search?: boolean;
  web_category_catalog?: WebCategory[];
  /** Headings the category switches are grouped under */
  web_category_groups?: WebCategoryGroup[];
  /** One-click settings (each sets every category; safe_search null = unchanged) */
  web_category_presets?: WebCategoryPreset[];
  demo_mode: boolean;
  updated_by?: string;
  updated_at?: string;
}

export interface WebCategory {
  id: string;
  name: string;
  description: string;
  default: boolean;
  group?: string;
}

export interface WebCategoryGroup {
  id: string;
  name: string;
  description: string;
}

export interface WebCategoryPreset {
  id: string;
  name: string;
  description: string;
  categories: Record<string, boolean>;
  safe_search: boolean | null;
}

export interface RuleCatalogItem {
  rule_id: string;
  category: string;
  name: string;
  description: string;
  default_action: PolicyAction;
  default_severity: SeverityLevel;
}

export interface Me {
  user_id: string;
  email: string;
  role: string;
  organization_id: string;
  organization_name: string;
  using_default_password: boolean;
  email_verified?: boolean;
  email_verification_required?: boolean;
  account_type?: 'INDIVIDUAL' | 'COMPANY';
  display_name?: string | null;
}

export interface AuditLogEntry {
  id: string;
  occurred_at: string;
  actor?: string;
  action: string;
  target_type?: string;
  target_id?: string;
  summary?: string;
  details?: string;
  ip_address?: string;
}

export interface EndpointInfo {
  secret_policy_active?: boolean | null;
  id: string;
  device_id: string;
  user_id?: string;
  extension_version?: string;
  browser?: string;
  platform?: string;
  policy_version?: number;
  enrollment_source?: string;
  first_seen_at?: string;
  last_seen_at?: string;
  status: 'ONLINE' | 'STALE' | 'OFFLINE';
  policy_current: boolean;
}

export interface DistributionTarget {
  id: string;
  update_url: string;
  source: 'self_hosted' | 'chrome_web_store' | 'edge_add_ons';
}

export interface DistributionInfo {
  version: string;
  built_at?: string;
  chrome: DistributionTarget;
  edge: DistributionTarget;
  requires_managed_device: boolean;
  zip_sha256?: string | null;
  zip_size?: number | null;
  store_links?: { chrome: string | null; edge: string | null };
  downloads?: { extension_zip: boolean };
}

// --- Licensing (SaaS) ---
export type EntitlementState =
  | 'TRIAL_ACTIVE' | 'SUBSCRIPTION_ACTIVE' | 'CREDITS_ACTIVE' | 'FREE_ACTIVE' | 'FREE_PAUSED'
  | 'LIMIT_REACHED' | 'CAP_REACHED' | 'NO_CREDITS'
  | 'EXPIRED' | 'NONE' | 'REVOKED' | 'SUSPENDED';

export interface Entitlement {
  state: EntitlementState;
  plan_code?: string | null;
  kind?: string | null;
  expires_at?: string | null;
  days_left?: number | null;
  device_limit: number;
  devices_used: number;
  last_expired_at?: string | null;
  credit_balance?: number;
  checks_this_month?: number;
  included_checks_used?: number;
  check_limit?: number | null;
  monthly_cap?: number | null;
  pay_with_credits?: boolean;
  /** FREE_PAUSED: browsers stay connected but prompt checks pause until resets_at */
  checks_paused?: boolean;
  /** When this month's prompt checks reset (monthly limits only) */
  resets_at?: string | null;
}

export interface LicenceRow {
  id: string;
  plan_code: string;
  kind: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'SCHEDULED';
  starts_at?: string | null;
  expires_at?: string | null;
  device_limit: number;
  payment_ref?: string | null;
  revoked_reason?: string | null;
  created_at?: string | null;
}

export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body?: string;
  read: boolean;
  created_at?: string;
}

export interface BillingStatus {
  server_time: string;
  entitlement: Entitlement;
  trial: { eligible: boolean; reason: string; days: number };
  /** The Free plan is chosen, never automatic (individual accounts) */
  free?: { eligible: boolean; reason: string; started_at: string | null };
  licences: LicenceRow[];
  notifications: AppNotification[];
}

export interface PlanInfo {
  code: string;
  name: string;
  kind: 'TRIAL' | 'PAID' | 'INTERNAL' | 'CREDITS' | 'FREE';
  duration_days?: number | null;
  duration_months?: number | null;
  device_limit: number;
  price_minor?: number | null;
  currency: string;
  billing: string;
  features: string[];
  purchasable: boolean;
  active: boolean;
  sort: number;
  /** CREDITS packs: prompt checks per purchase */
  credits?: number | null;
  /** FREE/TRIAL/PAID: prompt checks included per month (null = unlimited) */
  check_limit?: number | null;
}

export interface ReleaseInfo {
  version: string;
  notes?: string | null;
  sha256?: string | null;
  size_bytes?: number | null;
  min_chrome?: string | null;
  min_edge?: string | null;
  is_current: boolean;
  published_at?: string | null;
}

export interface PaymentConfig {
  payments_enabled: boolean;
  test_mode: boolean;
  key_id: string | null;
  seller: string;
}

export interface CheckoutSession {
  mode: 'order' | 'subscription';
  key_id: string;
  name: string;
  description: string;
  amount: number;
  currency: string;
  prefill: { email: string };
  test_mode: boolean;
  order: string;
  order_id?: string;
  subscription_id?: string;
}

export interface BillingPaymentRow {
  id: string;
  provider_payment_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  refunded_minor: number;
  receipt_number: string | null;
  created_at: string | null;
}

export interface BillingOrderRow {
  id: string;
  plan_code: string;
  kind: 'one_time' | 'subscription';
  amount_minor: number;
  currency: string;
  status: string;
  failure_reason: string | null;
  created_at: string | null;
  paid_at: string | null;
  payments: BillingPaymentRow[];
  organization?: string | null;
}

export interface SubscriptionInfo {
  plan_code: string;
  status: string;
  cancel_at_period_end: boolean;
  current_end: string | null;
}

export interface WebhookEventRow {
  event: string;
  provider_event_id: string;
  status: string;
  error: string | null;
  received_at: string | null;
  processed_at: string | null;
}

export interface PlatformCustomer {
  id: string;
  name: string;
  created_at?: string;
  suspended_at?: string | null;
  suspended_reason?: string | null;
  owner_email?: string | null;
  users: number;
  entitlement: Entitlement;
}

export interface PlatformCustomerDetail extends Omit<PlatformCustomer, 'users' | 'owner_email'> {
  licences: LicenceRow[];
  adjustments: { license_id: string; old_expires_at?: string; new_expires_at?: string; reason: string; by: string; at: string }[];
  trial_claim?: { email_domain: string; claimed_at: string } | null;
  users: { id: string; email: string; role: string; active: boolean; verified: boolean; created_at?: string }[];
  devices: { id: string; user_id: string; status: string; browser?: string; platform?: string; created_at?: string; last_seen_at?: string }[];
}

export interface PlatformMetrics {
  companies: number;
  accounts: number;
  by_state: Record<string, number>;
  trials_claimed: number;
  trial_conversions: number;
  active_devices: number;
  licensed_devices_used: number;
  licensed_device_capacity: number;
}

export interface EndpointSummary {
  total: number;
  online: number;
  stale: number;
  offline: number;
  outdated_policy: number;
  current_policy_version: number;
  items: EndpointInfo[];
}

export interface UserActionResponse {
  user_id: string;
  status: 'ACTIVE' | 'WARNED' | 'RESTRICTED' | 'SUSPENDED';
  notes?: string;
  action_taken_by?: string;
  updated_at: string;
}

export interface ReferralInfo {
  enabled: boolean;
  code?: string;
  link?: string;
  invited?: number;
  pending?: number;
  rewarded?: number;
  max_rewarded?: number;
  bonus_checks?: number;
  bonus_earned?: number;
}
