import {
  Account,
  AccountRole,
  ActivationTokenCreated,
  AuditLogEntry,
  AuthorizedDevice,
  ConnectedComputer,
  ApiTokenRow,
  BillingOrderRow,
  BillingStatus,
  CreditLedgerEntry,
  Entitlement,
  UsageSummary,
  CheckoutSession,
  DistributionInfo,
  PaymentConfig,
  SubscriptionInfo,
  WebhookEventRow,
  LicenceRow,
  PlanInfo,
  ReferralInfo,
  ReleaseInfo,
  EndpointSummary,
  InviteInfo,
  InviteSent,
  Me,
  PendingInvite,
  RuleCatalogItem,
  EvaluationResult,
  MetricsSummary,
  OrgSettings,
  Policy,
  RestrictedKeyword,
  SecurityEvent,
  UserActionResponse,
  UserRiskSummary,
  UserSession,
} from '../types';

const getApiBaseUrl = (): string => {
  const envUrl = import.meta.env.VITE_API_BASE_URL;
  if (envUrl !== undefined && envUrl !== '') {
    return envUrl.replace(/\/$/, '');
  }
  // In development, target default FastAPI backend on port 8000
  if (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    return 'http://localhost:8000';
  }
  // In production behind reverse proxy, use relative origin
  return '';
};

const API_BASE_URL = getApiBaseUrl();

/** Fired when the backend rejects the stored session, so the app can return to the login screen. */
export const SESSION_EXPIRED_EVENT = 'agentshield:session-expired';

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const err = await res.json().catch(() => ({}));
  if (typeof err.detail === 'string') return err.detail;
  if (err.detail && typeof err.detail.message === 'string') return err.detail.message;
  if (Array.isArray(err.detail) && err.detail[0]?.msg) return err.detail[0].msg;
  return fallback;
}

class ApiService {
  private getHeaders(): HeadersInit {
    const token = localStorage.getItem('agentshield_token');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  /** Authenticated request. An expired or invalid session signs the operator out. */
  private async authFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, { ...init, headers: this.getHeaders() });
    if (res.status === 401) {
      this.logout();
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    return res;
  }

  public async login(email: string, password: string): Promise<UserSession> {
    const res = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) throw new Error(await errorMessage(res, 'Sign-in failed. Check your email and password.'));

    return this.storeSession(await res.json());
  }

  public logout(): void {
    localStorage.removeItem('agentshield_token');
    localStorage.removeItem('agentshield_session');
  }

  public getStoredSession(): UserSession | null {
    const stored = localStorage.getItem('agentshield_session');
    if (!stored) return null;
    try {
      return JSON.parse(stored);
    } catch {
      return null;
    }
  }

  public async getPolicies(): Promise<{ policies: Policy[]; policy_version: number }> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/policies`, {
      headers: this.getHeaders(),
    });
    if (!res.ok) throw new Error('Failed to fetch policies');
    const data = await res.json();
    return {
      policies: data.policies || [],
      policy_version: data.policy_version || 1,
    };
  }

  public async createPolicy(policyData: Partial<Policy>): Promise<Policy> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/policies`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(policyData),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Failed to create policy');
    }
    return await res.json();
  }

  public async updatePolicy(id: string, updates: Partial<Policy>): Promise<Policy> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/policies/${id}`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Failed to update policy');
    }
    return await res.json();
  }

  public async deletePolicy(id: string): Promise<void> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/policies/${id}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    if (!res.ok) throw new Error('Failed to delete policy');
  }

  public async getEvents(params: {
    page?: number;
    pageSize?: number;
    user_id?: string;
    severity?: string;
    action?: string;
    accessType?: string;
    site?: string;
    department?: string;
    application?: string;
    dlpEngine?: string;
    timeFrame?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    ruleId?: string;
    since?: string;
  } = {}): Promise<{ total: number; items: SecurityEvent[] }> {
    const q = this.eventQuery(params);
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/events?${q.toString()}`, {
      headers: this.getHeaders(),
    });
    if (!res.ok) throw new Error('Failed to fetch events');
    const data = await res.json();
    return { total: data.total, items: data.items || [] };
  }

  /** Downloads the events matching the filters as a CSV file. */
  public async exportEventsCsv(params: Parameters<ApiService['getEvents']>[0] = {}): Promise<void> {
    const q = this.eventQuery(params);
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/events/export.csv?${q.toString()}`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Export failed'));
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agentshield-events-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  private eventQuery(params: {
    page?: number;
    pageSize?: number;
    user_id?: string;
    severity?: string;
    action?: string;
    accessType?: string;
    site?: string;
    department?: string;
    application?: string;
    dlpEngine?: string;
    timeFrame?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    ruleId?: string;
    since?: string;
  }): URLSearchParams {
    const q = new URLSearchParams();
    if (params.ruleId) q.append('rule_id', params.ruleId);
    if (params.since) q.append('since', params.since);
    if (params.page) q.append('page', String(params.page));
    if (params.pageSize) q.append('page_size', String(params.pageSize));
    if (params.user_id) q.append('user_id', params.user_id);
    if (params.severity) q.append('severity', params.severity);
    if (params.action) q.append('action', params.action);
    if (params.accessType) q.append('access_type', params.accessType);
    if (params.site) q.append('site', params.site);
    if (params.department) q.append('department', params.department);
    if (params.application) q.append('application', params.application);
    if (params.dlpEngine) q.append('dlp_engine', params.dlpEngine);
    if (params.timeFrame) q.append('time_frame', params.timeFrame);
    if (params.search) q.append('search', params.search);
    if (params.sortBy) q.append('sort_by', params.sortBy);
    if (params.sortOrder) q.append('sort_order', params.sortOrder);
    return q;
  }

  // --- Policy catalog, presets, audit log, endpoints, account ---
  public async getRuleCatalog(): Promise<RuleCatalogItem[]> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/policies/catalog`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load rule catalog'));
    return await res.json();
  }

  public async applyPreset(preset: 'recommended' | 'strict' | 'monitor'): Promise<void> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/policies/apply-preset`, {
      method: 'POST',
      body: JSON.stringify({ preset }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to apply preset'));
  }

  public async getAuditLog(page = 1, pageSize = 50, action?: string): Promise<{ total: number; items: AuditLogEntry[] }> {
    const q = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    if (action) q.append('action', action);
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/org/audit-log?${q.toString()}`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load audit log'));
    return await res.json();
  }

  public async getEndpoints(): Promise<EndpointSummary> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/endpoints`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load endpoints'));
    return await res.json();
  }

  /** Absolute URL of a file offered for download by the backend (installer, extension zip). */
  /** Downloads go through a 5-minute link that the server issues only to accounts with an active plan
   *  (each link is new, so a browser never reuses a copy cached from an earlier version). */
  public async downloadFile(file: 'agentshield-extension.zip' | 'AgentShield-Agent.exe'): Promise<void> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/me/download-link`, { method: 'POST', body: JSON.stringify({ file }) });
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not start the download'));
    const { url } = await res.json();
    window.location.assign(url);
  }

  /** Extension package and policy values for system-wide installs (public endpoint). */
  public async getDistributionInfo(): Promise<DistributionInfo | null> {
    const res = await fetch(`${API_BASE_URL}/extension-updates/info`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load package information'));
    return await res.json();
  }

  public async getMe(): Promise<Me> {
    const res = await this.authFetch(`${API_BASE_URL}/auth/me`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load account'));
    return await res.json();
  }

  // --- User Governance & Investigation Methods ---
  public async getUsersSummary(): Promise<UserRiskSummary[]> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/events/users/summary`, {
      headers: this.getHeaders(),
    });
    if (!res.ok) throw new Error('Failed to fetch user risk summaries');
    return await res.json();
  }

  public async takeUserAction(
    userId: string,
    action: 'SUSPEND' | 'RESTRICT' | 'WARN' | 'RESTORE',
    notes?: string
  ): Promise<UserActionResponse> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/events/users/${encodeURIComponent(userId)}/action`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ action, notes }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Failed to apply user governance action');
    }
    return await res.json();
  }

  public async getUserStatus(userId: string): Promise<{ user_id: string; status: string; notes?: string }> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/events/users/${encodeURIComponent(userId)}/status`, {
      headers: this.getHeaders(),
    });
    if (!res.ok) throw new Error('Failed to fetch user status');
    return await res.json();
  }

  public async getMetricsSummary(): Promise<MetricsSummary> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/metrics/summary`, {
      headers: this.getHeaders(),
    });
    if (!res.ok) throw new Error('Failed to fetch metrics summary');
    return await res.json();
  }

  public async evaluatePrompt(text: string, site = 'chatgpt.com'): Promise<EvaluationResult> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/policies/evaluate`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ text, site }),
    });
    if (!res.ok) throw new Error('Failed to evaluate prompt');
    return await res.json();
  }

  // --- Domain Traffic Control Methods ---
  public async getDomains(action?: string): Promise<{ total: number; domains: import('../types').DomainRule[] }> {
    let url = `${API_BASE_URL}/api/v1/domains`;
    if (action) url += `?action=${action}`;
    const res = await this.authFetch(url, { headers: this.getHeaders() });
    if (!res.ok) throw new Error('Failed to fetch domain rules');
    return await res.json();
  }

  public async createDomain(domainData: Partial<import('../types').DomainRule>): Promise<import('../types').DomainRule> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/domains`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(domainData),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Failed to create domain rule');
    }
    return await res.json();
  }

  public async updateDomain(id: string, updates: Partial<import('../types').DomainRule>): Promise<import('../types').DomainRule> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/domains/${id}`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error('Failed to update domain rule');
    return await res.json();
  }

  public async deleteDomain(id: string): Promise<void> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/domains/${id}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    if (!res.ok) throw new Error('Failed to delete domain rule');
  }

  // --- Accounts & invites ---
  private storeSession(data: any): UserSession {
    const session: UserSession = {
      token: data.access_token,
      user_id: data.user_id,
      email: data.email,
      role: data.role,
      organization_id: data.organization_id,
      organization_name: data.organization_name,
      account_type: data.account_type,
      email_verified: data.email_verified,
      email_verification_required: data.email_verification_required,
      display_name: data.display_name,
    };
    localStorage.setItem('agentshield_token', session.token);
    localStorage.setItem('agentshield_session', JSON.stringify(session));
    return session;
  }

  public async getSignupInfo(): Promise<{ enabled: boolean; allowed_domains: string[]; trial_days?: number; email_delivery?: boolean }> {
    const res = await fetch(`${API_BASE_URL}/auth/signup-info`);
    if (!res.ok) throw new Error('Unavailable');
    return await res.json();
  }

  /** Creates an individual account and signs it in; a confirmation link is emailed (needed for the free trial). */
  public async signUp(email: string, password: string, name?: string, referralCode?: string): Promise<UserSession> {
    const res = await fetch(`${API_BASE_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: name || undefined, account_type: 'INDIVIDUAL', referral_code: referralCode || undefined }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not create the account.'));
    return this.storeSession(await res.json());
  }

  public async resendVerification(email: string): Promise<void> {
    const res = await fetch(`${API_BASE_URL}/auth/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not send a new link.'));
  }

  public async updateProfile(display_name: string): Promise<Me> {
    const res = await this.authFetch(`${API_BASE_URL}/auth/me`, { method: 'PATCH', body: JSON.stringify({ display_name }) });
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not save your profile.'));
    const me: Me = await res.json();
    const stored = this.getStoredSession();
    if (stored) {
      localStorage.setItem('agentshield_session', JSON.stringify({ ...stored, display_name: me.display_name, organization_name: me.organization_name }));
    }
    return me;
  }

  /** Invite friends: own account's invite link and counts (individual accounts). */
  public async getReferrals(): Promise<ReferralInfo> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/referrals`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load invites'));
    return await res.json();
  }

  // --- Usage, credits and personal API tokens ---
  public async getUsage(days = 30): Promise<UsageSummary> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/usage?days=${days}`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load usage'));
    return await res.json();
  }

  public async setMonthlyCap(monthly_check_cap: number | null): Promise<Entitlement> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/usage/settings`, { method: 'PATCH', body: JSON.stringify({ monthly_check_cap }) });
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not save the limit'));
    return await res.json();
  }

  public async getCreditLedger(): Promise<{ balance: number; used_total: number; entries: CreditLedgerEntry[] }> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/usage/credits`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load credits'));
    return await res.json();
  }

  public async getApiTokens(): Promise<{ scopes: { scope: string; label: string }[]; tokens: ApiTokenRow[] }> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/me/api-tokens`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load API tokens'));
    return await res.json();
  }

  public async createApiToken(name: string, scopes: string[], expires_in_days: number | null): Promise<ApiTokenRow & { token: string }> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/me/api-tokens`, {
      method: 'POST', body: JSON.stringify({ name, scopes, expires_in_days }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not create the token'));
    return await res.json();
  }

  public async revokeApiToken(id: string): Promise<void> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/me/api-tokens/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not revoke the token'));
  }

  /** Base URL shown in API examples. */
  public apiBase(): string {
    return API_BASE_URL || window.location.origin;
  }

  public async verifyEmail(token: string): Promise<UserSession> {
    const res = await fetch(`${API_BASE_URL}/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'This confirmation link is not valid.'));
    return this.storeSession(await res.json());
  }

  public async getInviteInfo(token: string): Promise<InviteInfo> {
    const res = await fetch(`${API_BASE_URL}/auth/invite/${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error(await errorMessage(res, 'This invite link is not valid.'));
    return await res.json();
  }

  public async acceptInvite(token: string, password: string): Promise<UserSession> {
    const res = await fetch(`${API_BASE_URL}/auth/accept-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not create the account.'));
    return this.storeSession(await res.json());
  }

  public async getUsers(): Promise<{ users: Account[]; pending_invites: PendingInvite[] }> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/org/users`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load accounts'));
    return await res.json();
  }

  public async inviteUser(email: string, role: AccountRole): Promise<InviteSent> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/org/users/invite`, {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to send the invite'));
    return await res.json();
  }

  public async cancelInvite(id: string): Promise<void> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/org/invites/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to cancel the invite'));
  }

  public async updateUser(id: string, updates: { active?: boolean; role?: AccountRole }): Promise<Account> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/org/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to update the account'));
    return await res.json();
  }

  // --- Authorized browsers ---
  public async getOrgDevices(): Promise<AuthorizedDevice[]> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/org/devices`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load browsers'));
    return await res.json();
  }

  public async approveDevice(id: string): Promise<AuthorizedDevice> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/org/devices/${id}/approve`, { method: 'POST' });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to approve the browser'));
    return await res.json();
  }

  public async revokeDevice(id: string): Promise<AuthorizedDevice> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/org/devices/${id}/revoke`, { method: 'POST' });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to revoke the browser'));
    return await res.json();
  }

  // --- My activation (any signed-in account) ---
  public async createActivationToken(): Promise<ActivationTokenCreated> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/me/activation-tokens`, { method: 'POST' });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to generate an activation code'));
    return await res.json();
  }

  public async getMyDevices(): Promise<AuthorizedDevice[]> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/me/devices`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load your browsers'));
    return await res.json();
  }

  public async revokeMyDevice(id: string): Promise<AuthorizedDevice> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/me/devices/${id}/revoke`, { method: 'POST' });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to sign out the browser'));
    return await res.json();
  }

  /** PCs connected through the AgentShield Windows app, with their browsers. */
  public async getMyComputers(): Promise<ConnectedComputer[]> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/me/computers`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load your PCs'));
    return await res.json();
  }

  /** Removes a PC: every browser connected through it is signed out. */
  public async revokeMyComputer(id: string): Promise<ConnectedComputer> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/me/computers/${id}/revoke`, { method: 'POST' });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to remove the PC'));
    return await res.json();
  }

  // --- Deployment & Settings ---

  public async getKeywords(): Promise<RestrictedKeyword[]> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/org/keywords`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load keywords'));
    return await res.json();
  }

  public async addKeyword(keyword: string): Promise<RestrictedKeyword> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/org/keywords`, {
      method: 'POST',
      body: JSON.stringify({ keyword }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to add keyword'));
    return await res.json();
  }

  public async deleteKeyword(id: string): Promise<void> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/org/keywords/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to delete keyword'));
  }

  public async getOrgSettings(): Promise<OrgSettings> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/org/settings`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load settings'));
    return await res.json();
  }

  public async updateOrgSettings(updates: Partial<OrgSettings>): Promise<OrgSettings> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/org/settings`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to save settings'));
    return await res.json();
  }

  /** Changing the password ends every other session; the response carries this browser's new one. */
  public async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const res = await this.authFetch(`${API_BASE_URL}/auth/change-password`, {
      method: 'POST',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to change password'));
    this.storeSession(await res.json());
  }

  public async logoutEverywhere(): Promise<void> {
    await this.authFetch(`${API_BASE_URL}/auth/logout-all`, { method: 'POST' });
    this.logout();
  }

  public async forgotPassword(email: string): Promise<void> {
    const res = await fetch(`${API_BASE_URL}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not send the reset link.'));
  }

  public async resetPassword(token: string, password: string): Promise<UserSession> {
    const res = await fetch(`${API_BASE_URL}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, 'This reset link is not valid.'));
    return this.storeSession(await res.json());
  }

  // --- Licences and billing ---
  public async getBillingStatus(): Promise<BillingStatus> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/billing/status`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load your plan'));
    return await res.json();
  }

  public async getPlans(): Promise<PlanInfo[]> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/billing/plans`);
    if (!res.ok) throw new Error(await errorMessage(res, 'Failed to load plans'));
    return await res.json();
  }

  public async claimTrial(): Promise<LicenceRow> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/billing/trial`, { method: 'POST' });
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not start the free trial'));
    return await res.json();
  }

  public async startFreePlan(): Promise<Entitlement> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/billing/free`, { method: 'POST' });
    if (!res.ok) throw new Error(await errorMessage(res, 'Could not start the Free plan'));
    return await res.json();
  }

  public async markNotificationRead(id: string): Promise<void> {
    await this.authFetch(`${API_BASE_URL}/api/v1/billing/notifications/${id}/read`, { method: 'POST' });
  }

  // --- Payments (Razorpay hosted Checkout; the server creates and verifies every payment) ---
  private async billing<T>(path: string, init: RequestInit = {}, fallback = 'Request failed'): Promise<T> {
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/billing${path}`, init);
    if (!res.ok) throw new Error(await errorMessage(res, fallback));
    return await res.json();
  }

  public getPaymentConfig = () => this.billing<PaymentConfig>('/config');
  public startCheckout = (plan_code: string) =>
    this.billing<CheckoutSession>('/checkout', { method: 'POST', body: JSON.stringify({ plan_code }) }, 'Could not start the payment');
  public confirmCheckout = (result: Record<string, string>) =>
    this.billing<{ status: 'paid' | 'pending'; receipt_number?: string; message?: string }>(
      '/checkout/confirm', { method: 'POST', body: JSON.stringify(result) }, 'The payment could not be verified'
    );
  public getBillingOrders = () => this.billing<BillingOrderRow[]>('/orders');
  public getSubscription = () => this.billing<SubscriptionInfo | null>('/subscription');
  public cancelSubscription = () => this.billing('/subscription/cancel', { method: 'POST' }, 'Could not cancel the subscription');

  /** Opens a receipt (HTML from the server, fetched with the session) in a new tab. */
  public async openReceipt(paymentId: string): Promise<void> {
    const win = window.open('', '_blank');
    const res = await this.authFetch(`${API_BASE_URL}/api/v1/billing/payments/${paymentId}/receipt`);
    if (!res.ok) {
      win?.close();
      throw new Error(await errorMessage(res, 'Receipt not found'));
    }
    const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/html' }));
    if (win) win.location.href = url;
    else window.location.href = url;
  }

  public async getCurrentRelease(): Promise<ReleaseInfo | null> {
    const res = await fetch(`${API_BASE_URL}/api/v1/releases/current`);
    if (!res.ok) return null;
    return await res.json();
  }

  /** The backend URL employees' extensions should use (shown on the Deployment page). */
  public getApiBaseUrlForDisplay(): string {
    return API_BASE_URL || window.location.origin;
  }
}

export const api = new ApiService();

