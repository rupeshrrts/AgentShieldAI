/** Server times are UTC; some databases return them without a timezone suffix. */
export const parseUtc = (value: string): Date => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : value + 'Z');

export const formatDateTime = (value?: string | null): string => (value ? parseUtc(value).toLocaleString() : '—');

export const formatDate = (value?: string | null): string =>
  value ? parseUtc(value).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/** Amount in the currency's minor unit (paise/cents), e.g. 49900 INR -> "₹499". */
export const formatMoney = (minor?: number | null, currency = 'INR'): string => {
  if (minor === null || minor === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
};

export const planDuration = (p: { duration_days?: number | null; duration_months?: number | null }): string => {
  if (p.duration_months) return p.duration_months === 1 ? '1 month' : `${p.duration_months} months`;
  if (p.duration_days) return `${p.duration_days} days`;
  return 'No end date';
};

export const STATE_LABEL: Record<string, string> = {
  TRIAL_ACTIVE: 'Trial',
  SUBSCRIPTION_ACTIVE: 'Paid',
  CREDITS_ACTIVE: 'Pay as you go',
  FREE_ACTIVE: 'Free',
  FREE_PAUSED: 'Free · paused',
  LIMIT_REACHED: 'Checks used up',
  CAP_REACHED: 'Own limit reached',
  NO_CREDITS: 'Credits used up',
  INTERNAL: 'Internal',
  EXPIRED: 'Expired',
  NONE: 'No plan',
  REVOKED: 'Revoked',
  SUSPENDED: 'Suspended',
};

/** Tone for a status pill: ok, info, warn, bad, muted. */
export const STATE_TONE: Record<string, string> = {
  TRIAL_ACTIVE: 'info',
  SUBSCRIPTION_ACTIVE: 'ok',
  CREDITS_ACTIVE: 'ok',
  FREE_ACTIVE: 'info',
  FREE_PAUSED: 'warn',
  LIMIT_REACHED: 'warn',
  CAP_REACHED: 'warn',
  NO_CREDITS: 'warn',
  INTERNAL: 'muted',
  EXPIRED: 'warn',
  NONE: 'muted',
  REVOKED: 'bad',
  SUSPENDED: 'bad',
};
