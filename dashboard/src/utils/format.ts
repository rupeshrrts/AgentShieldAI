/** Server times are UTC; some databases return them without a timezone suffix. */
export const parseUtc = (value: string): Date => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : value + 'Z');

export const formatDateTime = (value?: string | null): string => (value ? parseUtc(value).toLocaleString() : '—');

export const formatDate = (value?: string | null): string =>
  value ? parseUtc(value).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/** Price in the currency's minor unit (paise/cents) to a display string, e.g. 49900 INR -> "₹499". */
export const formatMoney = (minor?: number | null, currency = 'INR'): string => {
  if (minor === null || minor === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
};

export const planDuration = (p: { duration_days?: number | null; duration_months?: number | null }): string => {
  if (p.duration_months) return p.duration_months === 1 ? '1 month' : p.duration_months === 12 ? '12 months' : `${p.duration_months} months`;
  if (p.duration_days) return `${p.duration_days} days`;
  return 'No end date';
};

export const STATE_LABEL: Record<string, string> = {
  TRIAL_ACTIVE: 'Free trial',
  SUBSCRIPTION_ACTIVE: 'Subscription active',
  CREDITS_ACTIVE: 'Pay as you go',
  FREE_ACTIVE: 'Free plan',
  FREE_PAUSED: 'Free plan · checks paused',
  LIMIT_REACHED: 'Monthly checks used up',
  CAP_REACHED: 'Usage limit reached',
  NO_CREDITS: 'Credits used up',
  EXPIRED: 'Expired',
  NONE: 'No plan',
  REVOKED: 'Revoked',
  SUSPENDED: 'Suspended',
};

export const STATE_CLASS: Record<string, string> = {
  TRIAL_ACTIVE: 'status-active',
  SUBSCRIPTION_ACTIVE: 'status-active',
  CREDITS_ACTIVE: 'status-active',
  FREE_ACTIVE: 'status-active',
  FREE_PAUSED: 'status-expired',
  LIMIT_REACHED: 'status-expired',
  CAP_REACHED: 'status-expired',
  NO_CREDITS: 'status-expired',
  EXPIRED: 'status-expired',
  NONE: 'status-revoked',
  REVOKED: 'status-expired',
  SUSPENDED: 'status-expired',
};

/** States in which protection is on. */
export const ACTIVE_STATES = ['TRIAL_ACTIVE', 'SUBSCRIPTION_ACTIVE', 'CREDITS_ACTIVE', 'FREE_ACTIVE'];

/** States in which browsers may stay connected (FREE_PAUSED: connected, prompt checks paused). */
export const ACCESS_STATES = [...ACTIVE_STATES, 'FREE_PAUSED'];

/** States that lock the browsers until the account owner acts. */
export const LOCKED_STATES = ['EXPIRED', 'SUSPENDED', 'REVOKED', 'LIMIT_REACHED', 'CAP_REACHED', 'NO_CREDITS'];

export const formatNumber = (n?: number | null): string => (n === null || n === undefined ? '—' : n.toLocaleString());
