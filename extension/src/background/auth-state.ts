/**
 * Activation and licence state machine (pure; unit-tested in tests/run-tests.js).
 *
 *   LOCKED -> CONNECTING -> AUTHENTICATING -> TRIAL_ACTIVE | SUBSCRIPTION_ACTIVE | FREE_ACTIVE | FREE_PAUSED
 *   (FREE_PAUSED: connected, AI sites and website controls work, but the free monthly prompt checks are used up,
 *   so prompt checks pause until the server says otherwise)
 *   failures: EXPIRED (the company's trial/plan ended), REVOKED, CONNECTION_ERROR,
 *             INVALID_TOKEN (activation code refused), PENDING_APPROVAL
 *
 * The service worker always starts in LOCKED. Only a session issued by the server after this
 * browser signed a fresh challenge, together with the server's licence verdict, moves it to an
 * active state, and that state lapses on its own when the session expires. Nothing read from
 * storage can set it, and the licence dates come from the server, never from this computer's clock.
 */
import { AuthStateName } from '../shared/types';

export type ActiveState = 'TRIAL_ACTIVE' | 'SUBSCRIPTION_ACTIVE' | 'FREE_ACTIVE' | 'FREE_PAUSED';

export interface LicenseInfo {
  state: string;
  plan?: string | null;
  /** Epoch ms when the company's licence ends (server time), if it ends */
  expiresAt?: number | null;
  daysLeft?: number | null;
  /** Prepaid prompt checks left (pay as you go), as reported by the server */
  credits?: number | null;
  /** Free plan: monthly prompt checks included (server) */
  checkLimit?: number | null;
  /** Prompt checks used this month (server) */
  checksThisMonth?: number | null;
  /** Epoch ms when this month's checks reset (server) */
  resetsAt?: number | null;
}

export interface AuthSnapshot {
  state: AuthStateName;
  message: string;
  /** Epoch ms when the server session expires (active states only). */
  expiresAt?: number;
  license?: LicenseInfo;
}

export type AuthEvent =
  | { type: 'START'; activated: boolean }
  | { type: 'CONNECT' }
  | { type: 'CHALLENGE_RECEIVED' }
  | { type: 'SESSION_GRANTED'; expiresAt: number; license: LicenseInfo }
  | { type: 'SERVER_REJECTED'; code: string; message?: string; license?: LicenseInfo }
  | { type: 'NETWORK_ERROR'; message?: string }
  | { type: 'SESSION_LOST' }
  | { type: 'SIGNED_OUT' };

export const MESSAGES: Record<AuthStateName, string> = {
  LOCKED: 'Activation required. Sign in to your AgentShield portal, claim your free trial or choose a plan, generate an activation code and paste it here.',
  CONNECTING: 'Connecting to the AgentShield server...',
  AUTHENTICATING: 'Verifying this browser and your licence...',
  TRIAL_ACTIVE: 'Free trial active. AI tools are protected by your company\'s rules.',
  SUBSCRIPTION_ACTIVE: 'Subscription active. AI tools are protected by your company\'s rules.',
  FREE_ACTIVE: 'Free plan active. AI tools are protected by your rules.',
  FREE_PAUSED: 'Protection paused: this month\'s free prompt checks are used. Website controls stay on. Prompt checks resume on the 1st, or upgrade in the portal.',
  EXPIRED: 'Your AgentShield plan, credits or usage limit has run out, so AI tools are blocked. Renew or buy credits in the portal, then click "Check again".',
  PENDING_APPROVAL: 'Waiting for an administrator to approve this browser. AI tools stay blocked until then.',
  CONNECTION_ERROR: 'Cannot reach the AgentShield server. AI tools stay blocked until the connection is restored.',
  INVALID_TOKEN: 'The activation code was not accepted. Generate a new code in the portal and try again.',
  REVOKED: 'This browser\'s access was revoked or the account is disabled. Activate it again or contact your administrator.',
};

/** Maps a server error code (backend api/device_auth.py, core/entitlements.py) to a state. */
export function stateForErrorCode(code: string): AuthStateName {
  switch (code) {
    case 'NO_LICENSE':
    case 'LICENSE_EXPIRED':
    case 'USAGE_LIMIT':   // plan's monthly prompt checks used up, no credits
    case 'SPEND_CAP':     // the account's own monthly limit reached
    case 'NO_CREDITS':    // pay-as-you-go credits used up
      return 'EXPIRED';
    case 'REVOKED':
    case 'ACCOUNT_DISABLED':
    case 'DEVICE_UNKNOWN':
    case 'INVALID_SIGNATURE':
    case 'LICENSE_REVOKED':
    case 'ORG_SUSPENDED':
      return 'REVOKED';
    case 'PENDING_APPROVAL':
      return 'PENDING_APPROVAL';
    default:
      // INVALID_TOKEN, EXPIRED (activation code), DEVICE_LIMIT, INVALID_DEVICE_KEY, unknown
      return 'INVALID_TOKEN';
  }
}

/**
 * True when the browser's identity itself is no longer valid and must be activated again.
 * Licence problems (expired, revoked licence, suspended company) keep the identity, so the
 * same browser reconnects by itself once the company's licence is restored.
 */
export function forgetsDevice(code: string): boolean {
  return ['REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_UNKNOWN', 'INVALID_SIGNATURE'].includes(code);
}

export function activeStateFor(licenseState: string): ActiveState | null {
  if (licenseState === 'TRIAL_ACTIVE' || licenseState === 'SUBSCRIPTION_ACTIVE') return licenseState;
  // Pay as you go: prepaid credits unlock protection like a subscription (the server meters each check)
  if (licenseState === 'CREDITS_ACTIVE') return 'SUBSCRIPTION_ACTIVE';
  // Free forever: FREE_PAUSED stays connected but prompt checks pause. Any other (unknown) state is refused.
  if (licenseState === 'FREE_ACTIVE' || licenseState === 'FREE_PAUSED') return licenseState;
  return null;
}

export const INITIAL: AuthSnapshot = { state: 'LOCKED', message: MESSAGES.LOCKED };

export function reduce(current: AuthSnapshot, event: AuthEvent): AuthSnapshot {
  switch (event.type) {
    case 'START':
      // Never resume a previous active state: always re-prove possession of the device key.
      return event.activated ? { state: 'CONNECTING', message: MESSAGES.CONNECTING } : INITIAL;
    case 'CONNECT':
      return { state: 'CONNECTING', message: MESSAGES.CONNECTING, license: current.license };
    case 'CHALLENGE_RECEIVED':
      return current.state === 'CONNECTING' ? { state: 'AUTHENTICATING', message: MESSAGES.AUTHENTICATING, license: current.license } : current;
    case 'SESSION_GRANTED': {
      if (current.state !== 'AUTHENTICATING' && !isActiveState(current.state)) return current;
      const state = activeStateFor(event.license?.state);
      if (!state) return { state: 'EXPIRED', message: MESSAGES.EXPIRED, license: event.license };
      return { state, message: MESSAGES[state], expiresAt: event.expiresAt, license: event.license };
    }
    case 'SERVER_REJECTED': {
      const state = stateForErrorCode(event.code);
      return { state, message: event.message || MESSAGES[state], license: event.license ?? current.license };
    }
    case 'NETWORK_ERROR':
      return { state: 'CONNECTION_ERROR', message: event.message || MESSAGES.CONNECTION_ERROR, license: current.license };
    case 'SESSION_LOST':
      return { state: 'CONNECTING', message: MESSAGES.CONNECTING, license: current.license };
    case 'SIGNED_OUT':
      return INITIAL;
    default:
      return current;
  }
}

export function isActiveState(state: AuthStateName): boolean {
  return state === 'TRIAL_ACTIVE' || state === 'SUBSCRIPTION_ACTIVE' || state === 'FREE_ACTIVE' || state === 'FREE_PAUSED';
}

/** Authorized, but the free monthly prompt checks are used up: prompts are not inspected (or metered). */
export function checksPaused(snapshot: AuthSnapshot, now: number = Date.now()): boolean {
  return snapshot.state === 'FREE_PAUSED' && isAuthorized(snapshot, now);
}

/** True only for a live, unexpired server session with an active trial, subscription or free plan. */
export function isAuthorized(snapshot: AuthSnapshot, now: number = Date.now()): boolean {
  return isActiveState(snapshot.state) && typeof snapshot.expiresAt === 'number' && snapshot.expiresAt > now;
}

/** Converts the server's entitlement JSON (session response or refusal) to LicenseInfo. */
export function licenseFromServer(ent: any): LicenseInfo | undefined {
  if (!ent || typeof ent !== 'object') return undefined;
  const expires = ent.expires_at ? Date.parse(ent.expires_at) : null;
  return {
    state: String(ent.state || ''),
    plan: ent.plan_code ?? null,
    expiresAt: Number.isFinite(expires) ? (expires as number) : null,
    daysLeft: typeof ent.days_left === 'number' ? ent.days_left : null,
    credits: typeof ent.credit_balance === 'number' ? ent.credit_balance : null,
    checkLimit: typeof ent.check_limit === 'number' ? ent.check_limit : null,
    checksThisMonth: typeof ent.checks_this_month === 'number' ? ent.checks_this_month : null,
    resetsAt: ent.resets_at && Number.isFinite(Date.parse(ent.resets_at)) ? Date.parse(ent.resets_at) : null,
  };
}

/** Retry delays (ms) for network failures before waiting for the periodic alarm or a manual retry. */
export const RETRY_DELAYS_MS = [2_000, 8_000, 30_000];
