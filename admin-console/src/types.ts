export interface StaffMe {
  id: string;
  email: string;
  name: string | null;
  role: string;
  role_label: string;
  permissions: string[];
  must_change_password: boolean;
  mfa_enabled: boolean;
}

export interface StaffSession {
  access_token: string;
  token_type: string;
  expires_in: number;
  staff: StaffMe;
}

export interface Entitlement {
  state: string;
  plan_code: string | null;
  kind: string | null;
  expires_at: string | null;
  days_left: number | null;
  device_limit: number | null;
  devices_used: number;
  credit_balance?: number;
  checks_this_month?: number;
  check_limit?: number | null;
  monthly_cap?: number | null;
}

export interface CompanyUsage {
  days: { day: string; prompt_checks: number; credit_checks: number }[];
  ledger: { delta: number; kind: string; reference: string | null; note: string | null; balance_after: number | null; created_by: string | null; created_at: string | null }[];
}

export interface Health {
  database: { ok: boolean; latency_ms: number };
  last_24h: Record<string, number>;
  current_release: string | null;
  extension_versions: Record<string, number>;
  server_time: string;
}

export interface Company {
  id: string;
  name: string;
  created_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  owner_email: string | null;
  users: number;
  entitlement: Entitlement;
  account_type?: 'INDIVIDUAL' | 'COMPANY';
  email_verified?: boolean;
}

export interface Licence {
  id: string;
  plan_code: string;
  kind: string;
  status: string;
  starts_at: string | null;
  expires_at: string | null;
  device_limit: number;
  payment_ref?: string | null;
}

export interface CompanyDetail extends Omit<Company, 'owner_email' | 'users'> {
  licences: Licence[];
  adjustments: { license_id: string; old_expires_at: string | null; new_expires_at: string | null; reason: string; by: string; at: string | null }[];
  trial_claim: { email_domain: string; claimed_at: string | null } | null;
  users: { id: string; email: string; role: string; active: boolean; verified: boolean; created_at: string | null }[];
  devices: { id: string; user_id: string; status: string; browser: string | null; platform: string | null; created_at: string | null; last_seen_at: string | null }[];
}

export interface Metrics {
  companies: number;
  accounts: number;
  by_state: Record<string, number>;
  trials_claimed: number;
  trial_conversions: number;
  active_devices: number;
  licensed_devices_used: number;
  licensed_device_capacity: number;
  accounts_by_type?: { INDIVIDUAL: number; COMPANY: number };
  prompt_checks_this_month?: number;
  credit_checks_this_month?: number;
  credits_outstanding?: number;
  credits_sold_this_month?: number;
  net_revenue_this_month?: Record<string, number>;
}

export interface Analytics {
  days: number;
  signups_daily: { day: string; individual: number; company: number }[];
  checks_daily: { day: string; prompt_checks: number; blocked: number; warned: number; redacted: number }[];
  actions: Record<string, number>;
  categories: Record<string, number>;
  browsers: Record<string, number>;
  platforms: Record<string, number>;
  top_accounts_this_month: { name: string; prompt_checks: number }[];
  users_by_role: Record<string, number>;
  individual_owners: { verified: number; unverified: number };
  referrals: Record<string, number>;
}

export interface Plan {
  code: string;
  name: string;
  kind: string;
  duration_days: number | null;
  duration_months: number | null;
  device_limit: number;
  price_minor: number | null;
  currency: string;
  billing: string;
  features: string[];
  purchasable: boolean;
  active: boolean;
  sort: number;
  credits?: number | null;
  check_limit?: number | null;
}

export interface Release {
  version: string;
  notes: string | null;
  sha256: string | null;
  size_bytes: number | null;
  min_chrome: string | null;
  min_edge: string | null;
  is_current: boolean;
  published_at: string | null;
}

export interface AuditRow {
  occurred_at: string | null;
  organization: string | null;
  actor: string | null;
  actor_type: string;
  action: string;
  summary: string | null;
  ip_address: string | null;
}

export interface BillingPayment {
  id: string;
  provider_payment_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  refunded_minor: number;
  receipt_number: string | null;
  created_at: string | null;
}

export interface BillingOrder {
  id: string;
  plan_code: string;
  kind: string;
  amount_minor: number;
  currency: string;
  status: string;
  failure_reason: string | null;
  created_at: string | null;
  paid_at: string | null;
  payments: BillingPayment[];
  organization?: string | null;
}

export interface WebhookEvent {
  event: string;
  provider_event_id: string;
  status: string;
  error: string | null;
  received_at: string | null;
  processed_at: string | null;
}

export interface StaffMember {
  id: string;
  email: string;
  name: string | null;
  role: string;
  role_label: string;
  active: boolean;
  mfa_enabled: boolean;
  must_change_password: boolean;
  invite_pending: boolean;
  last_login_at: string | null;
  created_at: string | null;
  created_by: string | null;
}
