/**
 * Internal console API client. Talks only to /internal/* on the backend with a staff session.
 * The session lives in sessionStorage (cleared when the tab closes). The server enforces every
 * permission; hiding buttons here is only a convenience.
 */
import type {
  Analytics, AuditRow, BillingOrder, Company, CompanyDetail, CompanyUsage, Health, Licence, Metrics, Plan, Release, StaffMember, StaffMe,
  StaffSession, WebhookEvent,
} from './types';

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ??
  (window.location.hostname === 'localhost' ? 'http://localhost:8000' : '');

const TOKEN_KEY = 'agentshield_staff_token';
export const SESSION_ENDED = 'agentshield-staff:session-ended';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

async function readError(res: Response, fallback: string): Promise<ApiError> {
  const body = await res.json().catch(() => ({}));
  const d = body?.detail;
  if (typeof d === 'string') return new ApiError(d, res.status);
  if (d && typeof d.message === 'string') return new ApiError(d.message, res.status, d.code);
  if (Array.isArray(d) && d[0]?.msg) return new ApiError(d[0].msg, res.status);
  return new ApiError(fallback, res.status);
}

export const session = {
  get: (): string | null => sessionStorage.getItem(TOKEN_KEY),
  set: (token: string) => sessionStorage.setItem(TOKEN_KEY, token),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
};

async function request<T>(path: string, init: RequestInit = {}, token?: string | null, fallback = 'Request failed'): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const bearer = token === undefined ? session.get() : token;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 401 && token === undefined && bearer) {
    session.clear();
    window.dispatchEvent(new Event(SESSION_ENDED));
  }
  if (!res.ok) throw await readError(res, fallback);
  if (res.status === 204) return undefined as T;
  return res.json();
}

const post = (body?: unknown): RequestInit => ({ method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = (body: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(body) });

export type LoginStep = { step: 'mfa' | 'mfa_setup'; token: string; must_change_password: boolean };

export const auth = {
  login: (email: string, password: string) =>
    request<LoginStep>('/internal/auth/login', post({ email, password }), null, 'Sign-in failed'),
  mfaSetup: (stepToken: string) =>
    request<{ secret: string; otpauth_uri: string; issuer: string }>('/internal/auth/mfa/setup', post(), stepToken),
  mfaEnable: (stepToken: string, code: string) =>
    request<{ recovery_codes: string[]; session: StaffSession }>('/internal/auth/mfa/enable', post({ code }), stepToken),
  mfaVerify: (stepToken: string, input: { code?: string; recovery_code?: string }) =>
    request<StaffSession>('/internal/auth/mfa/verify', post(input), stepToken),
  me: () => request<StaffMe>('/internal/auth/me'),
  changePassword: (current_password: string, new_password: string) =>
    request<StaffSession>('/internal/auth/change-password', post({ current_password, new_password })),
  logoutAll: () => request<void>('/internal/auth/logout-all', post()),
  inviteInfo: (token: string) => request<{ email: string; role: string; role_label: string }>(`/internal/auth/invite/${encodeURIComponent(token)}`, {}, null),
  acceptInvite: (token: string, password: string) => request<LoginStep>('/internal/auth/accept-invite', post({ token, password }), null),
};

export const api = {
  metrics: () => request<Metrics>('/internal/api/metrics'),
  analytics: (days = 30) => request<Analytics>(`/internal/api/analytics?days=${days}`),
  health: () => request<Health>('/internal/api/health'),
  companyUsage: (id: string) => request<CompanyUsage>(`/internal/api/companies/${id}/usage`),
  adjustCredits: (id: string, delta: number, reason: string) =>
    request<{ credit_balance: number }>(`/internal/api/companies/${id}/credits`, post({ delta, reason })),
  companies: () => request<Company[]>('/internal/api/companies'),
  company: (id: string) => request<CompanyDetail>(`/internal/api/companies/${id}`),
  suspendCompany: (id: string, reason: string) => request(`/internal/api/companies/${id}/suspend`, post({ reason })),
  unsuspendCompany: (id: string) => request(`/internal/api/companies/${id}/unsuspend`, post()),
  grantLicence: (id: string, plan_code: string, reason: string) => request<Licence>(`/internal/api/companies/${id}/licenses`, post({ plan_code, reason })),
  extendLicence: (id: string, add_days: number, reason: string) => request<Licence>(`/internal/api/licenses/${id}/extend`, post({ add_days, reason })),
  revokeLicence: (id: string, reason: string) => request<Licence>(`/internal/api/licenses/${id}/revoke`, post({ reason })),
  setBrowserLimit: (id: string, device_limit: number) => request<Licence>(`/internal/api/licenses/${id}`, patch({ device_limit })),
  suspendUser: (id: string) => request(`/internal/api/users/${id}/suspend`, post()),
  activateUser: (id: string) => request(`/internal/api/users/${id}/activate`, post()),
  plans: () => request<Plan[]>('/internal/api/plans'),
  updatePlan: (code: string, updates: Partial<Plan>) => request<Plan>(`/internal/api/plans/${code}`, patch(updates)),
  releases: () => request<Release[]>('/internal/api/releases'),
  publishRelease: (r: Partial<Release> & { version: string; make_current?: boolean }) => request<Release>('/internal/api/releases', post(r)),
  audit: (params: { action?: string; actor_type?: string }) => {
    const q = new URLSearchParams();
    if (params.action) q.set('action', params.action);
    if (params.actor_type) q.set('actor_type', params.actor_type);
    return request<AuditRow[]>(`/internal/api/audit?${q.toString()}`);
  },
  runReminders: () => request<{ created: number }>('/internal/api/jobs/run-reminders', post()),
  orders: () => request<BillingOrder[]>('/internal/api/billing/orders'),
  webhooks: () => request<WebhookEvent[]>('/internal/api/billing/webhooks'),
  refund: (paymentId: string, reason: string, amount_minor?: number) =>
    request<{ refund_id: string; status: string }>(`/internal/api/billing/payments/${paymentId}/refund`, post({ reason, amount_minor })),
  reconcile: () => request<{ checked: number; completed: number }>('/internal/api/billing/reconcile', post()),
  staff: () => request<{ roles: { role: string; label: string }[]; staff: StaffMember[] }>('/internal/api/staff'),
  inviteStaff: (email: string, role: string, name?: string) => request<StaffMember & { delivery: string }>('/internal/api/staff/invite', post({ email, role, name })),
  updateStaff: (id: string, updates: { role?: string; active?: boolean }) => request<StaffMember>(`/internal/api/staff/${id}`, patch(updates)),
  resetStaffMfa: (id: string) => request<StaffMember>(`/internal/api/staff/${id}/reset-mfa`, post()),
  endStaffSessions: (id: string) => request<StaffMember>(`/internal/api/staff/${id}/end-sessions`, post()),
};
