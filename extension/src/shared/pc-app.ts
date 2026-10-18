/**
 * The AgentShield Windows app (native messaging host "com.agentshield.helper", installed by
 * AgentShield-System-Setup.exe; source scripts/helper/AgentShieldHelper.cs).
 *
 * When this PC was connected once in the app, a locked browser asks the app for a single-use activation
 * code and activates with it exactly like a pasted code: this browser still creates its own key and the
 * server still checks every request. The app's reply never unlocks anything by itself.
 *
 * Pure helpers (unit-tested in tests/run-tests.js).
 */
import { parseActivationCode } from './config';

export const PC_APP_HOST = 'com.agentshield.helper';

/** missing: app not installed · not_connected: installed, PC not connected · connected · error */
export type PcAppState = 'unknown' | 'missing' | 'not_connected' | 'connected' | 'error';

export interface PcAppReply {
  ok?: boolean;
  code?: string;
  reason?: string;
  message?: string;
  connected?: boolean;
  email?: string;
}

export interface PcCodeResult {
  state: PcAppState;
  /** A well-formed activation code to activate with (still checked by the server) */
  code?: string;
  message?: string;
}

/** Interprets the app's answer to GET_CODE. A missing answer means the app is not installed. */
export function interpretCodeReply(reply: PcAppReply | null | undefined): PcCodeResult {
  if (!reply || typeof reply !== 'object') return { state: 'missing' };
  if (reply.ok === true && typeof reply.code === 'string' && parseActivationCode(reply.code)) {
    return { state: 'connected', code: reply.code };
  }
  if (reply.reason === 'NOT_CONNECTED' || reply.reason === 'REVOKED' || reply.reason === 'DEVICE_UNKNOWN' || reply.reason === 'ACCOUNT_DISABLED') {
    return { state: 'not_connected', message: typeof reply.message === 'string' ? reply.message : undefined };
  }
  return { state: 'error', message: typeof reply.message === 'string' ? reply.message : 'The AgentShield app could not connect this browser.' };
}

/** "Chrome 130", "Microsoft Edge 130", "Brave 1.70"... for the portal's browser list. */
export function browserLabel(uaData: any): string {
  const brand = uaData?.brands?.find((b: any) => !/not.?a.?brand|chromium/i.test(b.brand));
  return brand ? `${brand.brand} ${brand.version}` : 'Chromium';
}
