/// <reference types="chrome" />
/**
 * AgentShield Manifest V3 Service Worker
 * Manages browser activation, short-lived device sessions, policy synchronization,
 * network-level website blocking, endpoint heartbeats and audit event dispatching.
 *
 * Access model (fail closed):
 * - The worker always starts LOCKED. While locked, every AI site is blocked and no rules
 *   are synced. Installing, enabling or copying the extension grants nothing.
 * - A browser is activated once: the user signs in to the dashboard, generates a single-use
 *   activation code and pastes it here; the server binds the browser to that account
 *   through a non-extractable key pair (shared/device-identity.ts).
 * - Each session (DEVICE_SESSION_MINUTES on the server) is obtained by signing a fresh
 *   server challenge with that key. It is kept only in memory and chrome.storage.session
 *   (cleared when the browser closes) and is re-validated by the server on every call.
 * - Revocation, a disabled account or an unreachable server lock the browser again.
 */
import { ExtensionSyncState, SecurityEventPayload } from '../shared/types';
import { DEFAULT_API_BASE_URL, EXTENSION_VERSION, loadClientConfig, parseActivationCode, serverLockedByAdmin } from '../shared/config';
import { BlockReason, DomainLists, RULE_FOR_REASON, decideHost, lockedAiHosts, unapprovedAiDomains } from '../shared/domains';
import { createDeviceIdentity, deleteDeviceIdentity, hasDeviceIdentity, signWithDeviceKey } from '../shared/device-identity';
import { PC_APP_HOST, PcAppReply, PcAppState, browserLabel, interpretCodeReply } from '../shared/pc-app';
import { CATEGORY_LABELS, WEB_CATEGORY_IDS, effectiveCategories, rulesetsFor, safeSearchOn, safeSearchRules } from '../shared/web-categories';
import {
  AuthEvent,
  AuthSnapshot,
  INITIAL,
  LicenseInfo,
  MESSAGES,
  RETRY_DELAYS_MS,
  checksPaused,
  forgetsDevice,
  isAuthorized,
  licenseFromServer,
  reduce,
} from './auth-state';

const DEFAULT_BLOCKED_DOMAINS = [
  'ilovepdf.com',
  'smallpdf.com',
  'pdf2go.com',
  'freepdfconvert.com',
  'sodapdf.com',
  'sejda.com',
  'pastebin.com',
  'wetransfer.com',
  'pdfescape.com',
  'combinepdf.com',
  'docupub.com',
];

const MAX_QUEUED_EVENTS = 500;
const USER_STATUS_TTL_MS = 30_000;
// Refresh the session when less than this remains (the periodic alarm runs every 5 minutes)
const SESSION_REFRESH_MARGIN_MS = 6 * 60_000;
// Network rule ID ranges and priorities: explicit blocks (4) > activation lock (3) > allows (2) >
// unapproved AI (1) and website categories (static rulesets, 1). Safe Search rules use 40001+.
const RULE_ID_BLOCK = 1;
const RULE_ID_ALLOW = 10_001;
const RULE_ID_AI = 20_001;
const RULE_ID_LOCK = 30_001;
// AgentShield Windows app: ask it at most this often on its own (the popup can ask at once)
const PC_APP_MIN_INTERVAL_MS = 20_000;

/** Non-secret record of this browser's activation (the private key lives in IndexedDB). */
interface ActivationRecord {
  apiUrl: string;
  deviceId: string;
  email: string;
  organizationName: string;
}

interface DeviceSession {
  token: string;
  expiresAt: number;
  /** The server's licence verdict that came with this session */
  license?: LicenseInfo;
}

class BackgroundService {
  private configApiUrl = '';
  private dashboardUrl = '';
  private installId = '';
  private activation: ActivationRecord | null = null;
  private session: DeviceSession | null = null;
  private auth: AuthSnapshot = INITIAL;
  /** True while a session kept from before a service-worker restart is being re-validated. */
  private revalidating = false;
  private authInFlight: Promise<void> | null = null;
  private retryIndex = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  /** AgentShield Windows app on this PC (connects this browser without a pasted code) */
  private pcApp: PcAppState = 'unknown';
  private pcAppMessage = '';
  private pcAppLastTry = 0;
  private pcAppInFlight: Promise<void> | null = null;
  /** Set by "Sign out this browser" so the app does not reconnect it at once; it only stops asking. */
  private pcAutoConnectPaused = false;

  private syncState: ExtensionSyncState = {
    is_active: true,
    is_online: false,
    policy_version: 0,
    last_synced_at: '',
    organization_id: '',
    organization_name: 'AgentShield',
    // No rules until the organization's rules arrive from the server while authorized
    policies: [],
    settings: { store_clean_prompt_text: false, store_violation_prompt_text: true, block_unapproved_ai: false },
    ai_domains: [],
    auth_state: 'LOCKED',
    auth_message: MESSAGES.LOCKED,
  };

  private restrictedDomains: string[] = [...DEFAULT_BLOCKED_DOMAINS];
  private allowedDomains: string[] = [];
  private userStatusCache: { status: string; fetchedAt: number } | null = null;
  private recentDomainBlocks = new Map<string, number>();
  private ready: Promise<void>;

  constructor() {
    this.registerListeners();
    this.ready = this.init();
  }

  // ------------------------------------------------------------------ state helpers

  private authorized(): boolean {
    return isAuthorized(this.auth);
  }

  /** Free plan with its monthly prompt checks used up: connected, but prompts are not inspected. */
  private paused(): boolean {
    return checksPaused(this.auth);
  }

  /** AI sites are blocked unless authorized (or a kept session is still being re-validated). */
  private networkLocked(): boolean {
    return !this.authorized() && !this.revalidating;
  }

  private apiUrl(): string {
    return this.activation?.apiUrl || this.configApiUrl || DEFAULT_API_BASE_URL;
  }

  private lists(): DomainLists {
    return {
      blocked: this.restrictedDomains,
      allowed: this.allowedDomains,
      aiDomains: this.syncState.ai_domains || [],
      blockUnapprovedAi: Boolean(this.syncState.settings.block_unapproved_ai),
      locked: this.networkLocked(),
    };
  }

  private async transition(event: AuthEvent) {
    const wasLocked = this.networkLocked();
    const wasPaused = this.paused();
    this.auth = reduce(this.auth, event);
    this.syncState.auth_state = this.auth.state;
    this.syncState.auth_message = this.auth.message;
    if (wasLocked !== this.networkLocked()) {
      await this.applyBlockingRules();
      this.broadcastPoliciesUpdated();
    } else if (wasPaused !== this.paused()) {
      this.broadcastPoliciesUpdated();
    }
    await this.persist();
  }

  // ------------------------------------------------------------------ lifecycle

  private registerListeners() {
    // Backup interceptor: network rules handle most cases, this catches anything they miss
    chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      const urlStr = changeInfo.url;
      if (!urlStr || !/^https?:/i.test(urlStr)) return;
      this.ready.then(() => {
        try {
          const host = new URL(urlStr).hostname.toLowerCase();
          const reason = decideHost(host, this.lists());
          if (reason) {
            chrome.tabs.update(tabId, { url: this.blockedPageUrl(host, reason) });
            this.recordDomainBlock(host, reason);
          }
        } catch {
          // ignore malformed URLs
        }
      });
    });

    // Messages from content scripts, the popup and the blocked page (this extension only)
    chrome.runtime.onMessage.addListener(
      (message: any, sender: chrome.runtime.MessageSender, sendResponse: (res?: any) => void) => {
        if (sender.id !== chrome.runtime.id) return false;
        this.ready.then(() => this.handleMessage(message, sender, sendResponse));
        return true; // Keep message channel open for async responses
      }
    );

    // Re-read the server address when IT changes the policy
    chrome.storage.onChanged.addListener((_changes, areaName) => {
      if (areaName === 'managed') {
        this.applyConfig();
      }
    });

    // Refresh the session and sync policies every 5 minutes
    chrome.alarms.create('policy-refresh', { periodInMinutes: 5 });
    chrome.alarms.onAlarm.addListener((alarm: chrome.alarms.Alarm) => {
      if (alarm.name === 'policy-refresh') {
        this.ready.then(() => this.periodicRefresh());
      } else if (alarm.name === 'pc-app-connect') {
        this.ready.then(() => this.connectViaPcApp());
      }
    });
  }

  private async init() {
    try {
      const stored = await chrome.storage.local.get(['syncState', 'blocked_domains', 'allowed_domains', 'installId', 'activation', 'pcAutoConnectPaused']);
      // Only ever stops automatic connection through the Windows app; never grants anything
      this.pcAutoConnectPaused = stored.pcAutoConnectPaused === true;
      if (stored.syncState) {
        // Rules and display data only: the authorization state is never restored from storage
        const { auth_state: _a, auth_message: _m, ...rest } = stored.syncState;
        this.syncState = { ...this.syncState, ...rest, auth_state: 'LOCKED', auth_message: MESSAGES.LOCKED };
      }
      if (Array.isArray(stored.blocked_domains)) this.restrictedDomains = stored.blocked_domains;
      if (Array.isArray(stored.allowed_domains)) this.allowedDomains = stored.allowed_domains;
      this.installId = stored.installId || crypto.randomUUID();
      if (!stored.installId) await chrome.storage.local.set({ installId: this.installId });
      if (stored.activation && typeof stored.activation.deviceId === 'string') this.activation = stored.activation;
      await this.applyConfig();

      // A session from before this worker restarted (the browser is still open) is kept only
      // until the server confirms it below. A browser restart clears storage.session.
      const kept = await chrome.storage.session.get(['deviceSession']).catch(() => ({} as any));
      if (this.activation && kept.deviceSession?.token && kept.deviceSession.expiresAt > Date.now() + 30_000) {
        this.session = kept.deviceSession;
        this.revalidating = true;
      }
      await this.applyBlockingRules();
      await this.persist();
    } catch (e) {
      console.warn('[AgentShield SW] Initialization failed; staying locked.', e);
    }
    // Authenticate in the background so messages are answered immediately (as locked)
    void this.resume();
  }

  private async applyConfig() {
    const config = await loadClientConfig();
    this.configApiUrl = config.apiUrl || '';
    this.dashboardUrl = config.dashboardUrl || '';
  }

  /** Startup: re-validate a kept session with the server, otherwise run a full device sign-in. */
  private async resume() {
    if (this.session && this.revalidating) {
      this.auth = { state: 'AUTHENTICATING', message: MESSAGES.AUTHENTICATING };
      const ok = await this.syncPolicies(true);
      this.revalidating = false;
      if (ok && this.session?.license) {
        await this.transition({ type: 'SESSION_GRANTED', expiresAt: this.session.expiresAt, license: this.session.license });
        this.scheduleExpiry();
        return;
      }
      await this.applyBlockingRules();
    }
    await this.authenticate();
  }

  // ------------------------------------------------------------------ device sign-in

  private async authenticate(): Promise<void> {
    if (this.authInFlight) return this.authInFlight;
    this.authInFlight = this.doAuthenticate().finally(() => {
      this.authInFlight = null;
    });
    return this.authInFlight;
  }

  private async doAuthenticate(): Promise<void> {
    if (!this.activation || !(await hasDeviceIdentity())) {
      await this.dropSession();
      await this.transition({ type: 'START', activated: false });
      // Not activated: if this PC was connected in the AgentShield Windows app, get a code from it
      void this.connectViaPcApp();
      return;
    }
    // Refreshing a live session happens quietly; AI sites stay usable until it actually expires.
    const refreshing = this.authorized();
    if (!refreshing) await this.transition({ type: 'CONNECT' });
    const deviceId = this.activation.deviceId;
    try {
      const challenge = await fetch(`${this.apiUrl()}/api/v1/device/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId }),
      });
      if (!challenge.ok) return this.handleRejection(challenge);
      const { nonce } = await challenge.json();
      if (!refreshing) await this.transition({ type: 'CHALLENGE_RECEIVED' });

      const signature = await signWithDeviceKey(nonce);
      if (!signature) {
        await this.forgetDevice();
        await this.transition({ type: 'SERVER_REJECTED', code: 'INVALID_SIGNATURE' });
        return;
      }
      const res = await fetch(`${this.apiUrl()}/api/v1/device/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId, nonce, signature }),
      });
      if (!res.ok) return this.handleRejection(res);
      const data = await res.json();
      const license = licenseFromServer(data.entitlement) || { state: '' };
      this.session = { token: data.session_token, expiresAt: Date.now() + Number(data.expires_in) * 1000, license };
      await chrome.storage.session.set({ deviceSession: this.session }).catch(() => undefined);
      this.syncState.user_email = data.user_email;
      if (data.organization_name) this.syncState.organization_name = data.organization_name;
      this.retryIndex = 0;
      await this.transition({ type: 'SESSION_GRANTED', expiresAt: this.session.expiresAt, license });
      this.scheduleExpiry();
      await this.syncPolicies();
    } catch {
      if (!this.authorized()) await this.transition({ type: 'NETWORK_ERROR' });
      this.scheduleRetry();
    }
  }

  private async errorCode(res: Response): Promise<{ code: string; message?: string; license?: LicenseInfo }> {
    try {
      const body = await res.json();
      const detail = body?.detail;
      if (detail && typeof detail === 'object') {
        return { code: String(detail.code || ''), message: detail.message, license: licenseFromServer(detail.entitlement) };
      }
      return { code: res.status === 429 ? 'RATE_LIMITED' : '', message: typeof detail === 'string' ? detail : undefined };
    } catch {
      return { code: '' };
    }
  }

  private async handleRejection(res: Response) {
    if (res.status >= 500 || res.status === 429) {
      const { message } = await this.errorCode(res);
      if (!this.authorized()) {
        await this.transition({ type: 'NETWORK_ERROR', message: message || `The AgentShield server returned an error (HTTP ${res.status}). AI tools stay blocked.` });
      }
      this.scheduleRetry();
      return;
    }
    const { code, message, license } = await this.errorCode(res);
    await this.dropSession();
    await this.transition({ type: 'SERVER_REJECTED', code, message, license });
    // An ended or revoked licence keeps this browser's identity, so it reconnects by itself
    // (5-minute check, or "Check again") once the company's licence is active again.
    if (forgetsDevice(code)) await this.forgetDevice();
  }

  private scheduleRetry() {
    if (this.retryIndex >= RETRY_DELAYS_MS.length) return; // the 5-minute alarm or a manual Retry continues
    const delay = RETRY_DELAYS_MS[this.retryIndex++];
    setTimeout(() => void this.authenticate(), delay);
  }

  private scheduleExpiry() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.lockTimer) clearTimeout(this.lockTimer);
    if (!this.session) return;
    const expiresAt = this.session.expiresAt;
    // Refresh a few minutes early...
    this.expiryTimer = setTimeout(() => void this.authenticate(), Math.max(0, expiresAt - Date.now() - SESSION_REFRESH_MARGIN_MS / 2));
    // ...and lock the moment the session expires if no refresh succeeded (e.g. server unreachable)
    this.lockTimer = setTimeout(() => void this.onSessionExpired(expiresAt), Math.max(0, expiresAt - Date.now() + 500));
  }

  private async onSessionExpired(expiresAt: number) {
    if (this.session && this.session.expiresAt > expiresAt) return; // refreshed meanwhile
    await this.dropSession();
    await this.transition({ type: 'SESSION_LOST' });
    await this.authenticate();
  }

  private async periodicRefresh() {
    if (!this.activation) {
      await this.connectViaPcApp();
      return;
    }
    if (!this.authorized() || !this.session || this.session.expiresAt - Date.now() < SESSION_REFRESH_MARGIN_MS) {
      this.retryIndex = 0;
      await this.authenticate();
    } else {
      await this.syncPolicies();
    }
  }

  private async dropSession() {
    this.session = null;
    this.revalidating = false;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.lockTimer) clearTimeout(this.lockTimer);
    await chrome.storage.session.remove('deviceSession').catch(() => undefined);
  }

  /** Removes everything that identified this browser, so it must be activated again. */
  private async forgetDevice() {
    await this.dropSession();
    await deleteDeviceIdentity();
    this.activation = null;
    this.syncState.user_email = undefined;
    this.syncState.policies = [];
    this.syncState.keywords = undefined;
    await chrome.storage.local.remove('activation');
  }

  /**
   * Connect from the popup: the single-use code the user generated while signed in to the
   * dashboard (it identifies their account) + this browser's new device key.
   */
  private async activate(code: string): Promise<{ ok: boolean; pending?: boolean; error?: string }> {
    const parsed = parseActivationCode(code);
    if (!parsed) {
      return { ok: false, error: 'That activation code is not valid. Copy the full code (it starts with ASA1.) from your AgentShield dashboard.' };
    }
    if (serverLockedByAdmin({ apiUrl: this.configApiUrl }) && parsed.apiUrl !== this.configApiUrl) {
      return { ok: false, error: 'This code is for a different server than the one your IT team configured.' };
    }

    await this.forgetDevice();
    await this.transition({ type: 'CONNECT' });
    let publicKey: string;
    try {
      publicKey = await createDeviceIdentity();
    } catch {
      await this.transition({ type: 'SERVER_REJECTED', code: 'INVALID_DEVICE_KEY', message: 'This browser could not create a secure device key.' });
      return { ok: false, error: this.auth.message };
    }

    const uaData = (navigator as any).userAgentData;
    let res: Response;
    try {
      res = await fetch(`${parsed.apiUrl}/api/v1/device/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activation_token: parsed.token,
          public_key: publicKey,
          browser: browserLabel(uaData),
          platform: uaData?.platform || navigator.platform || '',
        }),
      });
    } catch {
      await deleteDeviceIdentity();
      await this.transition({ type: 'NETWORK_ERROR' });
      return { ok: false, error: this.auth.message };
    }

    if (!res.ok) {
      await deleteDeviceIdentity();
      if (res.status >= 500 || res.status === 429) {
        const { message } = await this.errorCode(res);
        await this.transition({ type: 'NETWORK_ERROR', message });
      } else {
        const { code: errCode, message } = await this.errorCode(res);
        await this.transition({ type: 'SERVER_REJECTED', code: errCode, message });
      }
      return { ok: false, error: this.auth.message };
    }

    const data = await res.json();
    this.activation = {
      apiUrl: parsed.apiUrl,
      deviceId: data.device_id,
      email: data.user_email,
      organizationName: data.organization_name,
    };
    await chrome.storage.local.set({ activation: this.activation });
    this.syncState.user_email = data.user_email;
    this.syncState.organization_name = data.organization_name || this.syncState.organization_name;

    if (data.status === 'PENDING') {
      await this.transition({ type: 'SERVER_REJECTED', code: 'PENDING_APPROVAL' });
      return { ok: true, pending: true };
    }
    this.retryIndex = 0;
    await this.authenticate();
    return this.authorized() ? { ok: true } : { ok: false, error: this.auth.message };
  }

  private async signOut() {
    if (this.authorized()) {
      await this.apiFetch('/api/v1/device/deactivate', { method: 'POST' }).catch(() => undefined);
    }
    await this.forgetDevice();
    // Signed out on purpose: do not reconnect through the Windows app until the person asks again
    await this.setPcAutoConnectPaused(true);
    await this.transition({ type: 'SIGNED_OUT' });
  }

  // ------------------------------------------------------------------ AgentShield Windows app

  private async setPcAutoConnectPaused(paused: boolean) {
    this.pcAutoConnectPaused = paused;
    await chrome.storage.local.set({ pcAutoConnectPaused: paused }).catch(() => undefined);
  }

  /** One request to the Windows app; null when it is not installed (or cannot be started). */
  private askPcApp(message: Record<string, unknown>): Promise<PcAppReply | null> {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime.sendNativeMessage) return resolve(null);
        chrome.runtime.sendNativeMessage(PC_APP_HOST, message, (reply: PcAppReply) => {
          resolve(chrome.runtime.lastError ? null : reply || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * Not activated: ask the Windows app for a single-use code and activate with it like a pasted code.
   * While the app is installed but the PC is not connected yet, ask again every minute, so the browser
   * connects by itself shortly after the person connects the PC.
   */
  private async connectViaPcApp(force = false): Promise<void> {
    if (this.activation || (this.pcAutoConnectPaused && !force)) return;
    if (this.pcAppInFlight) return this.pcAppInFlight;
    if (!force && Date.now() - this.pcAppLastTry < PC_APP_MIN_INTERVAL_MS) return;
    this.pcAppLastTry = Date.now();
    this.pcAppInFlight = (async () => {
      const result = interpretCodeReply(await this.askPcApp({ type: 'GET_CODE', browser: browserLabel((navigator as any).userAgentData) }));
      this.pcApp = result.state;
      this.pcAppMessage = result.message || '';
      if (result.state === 'not_connected') {
        chrome.alarms.create('pc-app-connect', { periodInMinutes: 1 });
      } else {
        await chrome.alarms.clear('pc-app-connect').catch(() => false);
      }
      if (result.code && !this.activation) {
        const outcome = await this.activate(result.code);
        if (!outcome.ok && outcome.error) this.pcAppMessage = outcome.error;
      }
    })().finally(() => {
      this.pcAppInFlight = null;
    });
    return this.pcAppInFlight;
  }

  // ------------------------------------------------------------------ authorized API calls

  /** Fetch with the device session. A 401/403 means the session is gone: lock and re-authenticate. */
  private async apiFetch(path: string, init: RequestInit = {}, allowRevalidation = false): Promise<Response> {
    if (!this.session || (!this.authorized() && !(allowRevalidation && this.revalidating))) {
      throw new Error('not authorized');
    }
    const headers = { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${this.session.token}` };
    const res = await fetch(`${this.apiUrl()}${path}`, { ...init, headers });
    if (res.status === 401 || res.status === 403) {
      await this.dropSession();
      await this.transition({ type: 'SESSION_LOST' });
      void this.authenticate();
    }
    return res;
  }

  public async syncPolicies(revalidation = false): Promise<boolean> {
    try {
      // 1. Policies, keywords and settings
      const res = await this.apiFetch('/api/v1/policies', {}, revalidation);
      if (!res.ok) throw new Error(`Policy sync failed (HTTP ${res.status}).`);
      const data = await res.json();
      this.syncState.policy_version = data.policy_version || this.syncState.policy_version;
      this.syncState.organization_id = data.organization_id || this.syncState.organization_id;
      if (data.organization_name) this.syncState.organization_name = data.organization_name;
      if (Array.isArray(data.policies)) this.syncState.policies = data.policies;
      if (Array.isArray(data.keywords)) this.syncState.keywords = data.keywords;
      if (Array.isArray(data.ai_domains)) this.syncState.ai_domains = data.ai_domains;
      if (data.settings) this.syncState.settings = { ...this.syncState.settings, ...data.settings };
      // The server's current verdict (e.g. free prompt checks paused or resumed) without waiting for a new session
      const license = licenseFromServer(data.entitlement);
      if (license && this.session) {
        this.session.license = license;
        await chrome.storage.session.set({ deviceSession: this.session }).catch(() => undefined);
        if (this.authorized()) await this.transition({ type: 'SESSION_GRANTED', expiresAt: this.session.expiresAt, license });
      }

      // 2. Website rules
      const domainRes = await this.apiFetch('/api/v1/domains', {}, revalidation);
      if (domainRes.ok) {
        const domainData = await domainRes.json();
        if (Array.isArray(domainData.domains)) {
          this.syncState.domain_rules = domainData.domains;
          this.restrictedDomains = domainData.domains
            .filter((d: any) => d.action === 'BLOCK' && d.enabled)
            .map((d: any) => String(d.domain).toLowerCase().trim());
          this.allowedDomains = domainData.domains
            .filter((d: any) => d.action === 'ALLOW' && d.enabled)
            .map((d: any) => String(d.domain).toLowerCase().trim());
        }
      }
      await this.applyBlockingRules();

      this.syncState.is_online = true;
      this.syncState.last_error = undefined;
      this.syncState.last_synced_at = new Date().toISOString();
      this.userStatusCache = null;
      await this.persist();
      this.broadcastPoliciesUpdated();
      await this.sendHeartbeat();
      await this.flushEventQueue();
      return true;
    } catch (e: any) {
      this.syncState.is_online = false;
      this.syncState.last_error = this.authorized() ? e?.message || 'Cannot reach the AgentShield server.' : undefined;
      await this.persist();
      return false;
    }
  }

  private async sendHeartbeat() {
    if (!this.activation) return;
    try {
      const uaData = (navigator as any).userAgentData;
      const brand = uaData?.brands?.find((b: any) => !/not.?a.?brand|chromium/i.test(b.brand));
      await this.apiFetch('/api/v1/endpoints/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: this.activation.deviceId,
          user_id: this.activation.email,
          extension_version: EXTENSION_VERSION,
          browser: brand ? `${brand.brand} ${brand.version}` : 'Chromium',
          platform: uaData?.platform || navigator.platform || '',
          policy_version: this.syncState.policy_version,
          enrollment_source: 'activation',
        }),
      });
    } catch {
      // Heartbeats are best-effort
    }
  }

  private async persist() {
    this.syncState.blocked_domains = this.restrictedDomains;
    this.syncState.allowed_domains = this.allowedDomains;
    await chrome.storage.local.set({
      syncState: this.syncState,
      policies: this.syncState.policies,
      keywords: this.syncState.keywords,
      settings: this.syncState.settings,
      domain_rules: this.syncState.domain_rules || [],
      blocked_domains: this.restrictedDomains,
      allowed_domains: this.allowedDomains,
      domain_lists: this.lists(),
    });
  }

  /**
   * Installs network-level rules so blocked pages never load at all (unlike a script
   * redirect, which runs after the request has started). Explicit blocks outrank the
   * activation lock, which outranks allows, which outrank the "unapproved AI" blocks.
   */
  private async applyBlockingRules() {
    if (!chrome.declarativeNetRequest?.updateDynamicRules) return;
    try {
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      const removeRuleIds = existing.map((r) => r.id);
      const org = encodeURIComponent(this.syncState.organization_name || 'AgentShield');
      const mainFrame = ['main_frame' as chrome.declarativeNetRequest.ResourceType];
      const redirect = (domain: string, reason: BlockReason, id: number, priority: number): chrome.declarativeNetRequest.Rule => ({
        id,
        priority,
        action: {
          type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
          redirect: { extensionPath: `/blocked.html?domain=${encodeURIComponent(domain)}&org=${org}&reason=${reason}` },
        },
        condition: { requestDomains: [domain], resourceTypes: mainFrame },
      });

      const lists = this.lists();
      const blocked = Array.from(new Set(this.restrictedDomains.filter(Boolean))).slice(0, 4000);
      const allowed = Array.from(new Set(this.allowedDomains.filter(Boolean))).slice(0, 2000);
      const aiBlocked = unapprovedAiDomains(lists).slice(0, 1000);
      const lockedHosts = lists.locked ? lockedAiHosts(lists).slice(0, 1000) : [];

      const settings = this.syncState.settings;
      const addRules: chrome.declarativeNetRequest.Rule[] = [
        ...blocked.map((d, i) => redirect(d, 'policy', RULE_ID_BLOCK + i, 4)),
        ...lockedHosts.map((d, i) => redirect(d, 'activation_required', RULE_ID_LOCK + i, 3)),
        // ALLOW rules also make exceptions to the website categories (priority 1)
        ...allowed.map((d, i) => ({
          id: RULE_ID_ALLOW + i,
          priority: 2,
          action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType },
          condition: { requestDomains: [d], resourceTypes: ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[] },
        })),
        ...aiBlocked.map((d, i) => redirect(d, 'unapproved_ai', RULE_ID_AI + i, 1)),
        ...(safeSearchOn(settings.safe_search, settings.web_categories) ? safeSearchRules() : []),
      ];
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    } catch (e) {
      console.warn('[AgentShield SW] Failed to install network blocking rules:', e);
    }
    await this.applyCategoryRules();
  }

  /**
   * Switches the built-in category rulesets (rulesets/<id>.json) to match the server's settings.
   * Missing or malformed settings fall back to the safe defaults, never to "all off".
   */
  private async applyCategoryRules() {
    if (!chrome.declarativeNetRequest?.updateEnabledRulesets) return;
    try {
      const { enable, disable } = rulesetsFor(this.syncState.settings.web_categories);
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: enable, disableRulesetIds: disable });
    } catch (e) {
      console.warn('[AgentShield SW] Failed to switch website category rules:', e);
    }
  }

  // ------------------------------------------------------------------ messages

  private blockedPageUrl(host: string, reason: BlockReason): string {
    const org = this.syncState.organization_name || 'AgentShield';
    return chrome.runtime.getURL(
      `blocked.html?domain=${encodeURIComponent(host)}&org=${encodeURIComponent(org)}&reason=${reason}`
    );
  }

  private statusResponse() {
    return {
      ...this.syncState,
      auth_state: this.auth.state,
      auth_message: this.auth.message,
      authorized: this.authorized(),
      session_expires_at: this.authorized() ? this.auth.expiresAt : undefined,
      checks_paused: this.paused(),
      // Licence verdict from the server (state, plan, end date); never computed from this computer's clock
      license: this.auth.license || null,
      activated: Boolean(this.activation),
      user_email: this.activation?.email || '',
      user_id: this.activation?.email || '',
      activeRulesCount: this.syncState.policies.filter((p) => p.enabled).length,
      blockedDomainsCount: this.restrictedDomains.length + unapprovedAiDomains(this.lists()).length,
      allowedDomainsCount: this.allowedDomains.length,
      api_url: this.apiUrl(),
      server_locked: serverLockedByAdmin({ apiUrl: this.configApiUrl }),
      // AgentShield Windows app on this PC: missing / not_connected / connected / error (display only)
      pc_app: this.pcApp,
      pc_app_message: this.pcAppMessage,
      pc_auto_connect_paused: this.pcAutoConnectPaused,
      // IT-set dashboard address; otherwise the dashboard is usually served by the same server
      dashboard_url: this.dashboardUrl || (/\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(this.apiUrl()) ? 'http://localhost:5173' : this.apiUrl()),
    };
  }

  private async handleMessage(message: any, sender: chrome.runtime.MessageSender, sendResponse: (res?: any) => void) {
    if (!message || !message.type) {
      sendResponse({ error: 'Invalid message' });
      return;
    }
    // Account actions are only accepted from the extension's own pages (the popup),
    // never from content scripts running inside web pages.
    const fromExtensionPage = !sender.tab && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

    switch (message.type) {
      case 'GET_STATUS':
        // Opening the popup of a locked browser also asks the Windows app (rate-limited)
        if (!this.activation && fromExtensionPage) void this.connectViaPcApp();
        sendResponse(this.statusResponse());
        break;

      case 'GET_POLICIES':
        sendResponse({
          authorized: this.authorized(),
          auth_state: this.auth.state,
          checks_paused: this.paused(),
          policies: this.authorized() ? this.syncState.policies : [],
          keywords: this.syncState.keywords,
          settings: this.syncState.settings,
          policy_version: this.syncState.policy_version,
          is_online: this.syncState.is_online,
          user_id: this.activation?.email || '',
        });
        break;

      case 'GET_DOMAIN_LISTS':
        sendResponse(this.lists());
        break;

      case 'GET_USER_STATUS':
        sendResponse({ status: await this.getUserStatus(), authorized: this.authorized(), checks_paused: this.paused() });
        break;

      case 'TRIGGER_SYNC':
      case 'RETRY':
        this.retryIndex = 0;
        if (this.authorized()) await this.syncPolicies();
        else await this.authenticate();
        sendResponse(this.statusResponse());
        break;

      case 'ACTIVATE':
        if (!fromExtensionPage) {
          sendResponse({ ok: false, error: 'Not allowed.' });
          break;
        }
        await this.setPcAutoConnectPaused(false);
        sendResponse(await this.activate(String(message.code || '')));
        break;

      case 'CONNECT_VIA_PC': {
        // Popup: "Connect with the AgentShield app". Connects at once when the PC is connected;
        // otherwise opens the app's window to connect the PC.
        if (!fromExtensionPage) {
          sendResponse({ ok: false, error: 'Not allowed.' });
          break;
        }
        await this.setPcAutoConnectPaused(false);
        await this.connectViaPcApp(true);
        if (this.pcApp === 'not_connected') await this.askPcApp({ type: 'OPEN_CONNECT' });
        sendResponse({ ok: this.authorized(), pc_app: this.pcApp, error: this.pcAppMessage || undefined });
        break;
      }

      case 'SIGN_OUT':
        if (!fromExtensionPage) {
          sendResponse({ ok: false });
          break;
        }
        await this.signOut();
        sendResponse({ ok: true });
        break;

      case 'RECORD_SECURITY_EVENT':
        if (message.event) {
          this.forwardAuditEvent(message.event);
        }
        sendResponse({ received: true });
        break;

      case 'DOMAIN_BLOCKED':
        if (typeof message.domain === 'string' && message.domain) {
          const host = message.domain.toLowerCase();
          // Only log hosts that really are blocked (the block page can be opened by any site)
          const reason = decideHost(host, this.lists());
          if (reason) this.recordDomainBlock(host, reason);
        }
        sendResponse({ received: true });
        break;

      case 'CATEGORY_BLOCKED': {
        // Sent by the block page after a category ruleset redirected a page. Only categories that
        // are really switched on are logged (any site can open the block page).
        const category = String(message.category || '');
        if (WEB_CATEGORY_IDS.includes(category) && effectiveCategories(this.syncState.settings.web_categories)[category]) {
          this.recordCategoryBlock(category);
        }
        sendResponse({ received: true });
        break;
      }

      default:
        sendResponse({ error: 'Unknown message type' });
    }
  }

  /** Logs a blocked navigation once per domain every 10 seconds (several layers may report it). */
  private recordDomainBlock(host: string, reason: BlockReason) {
    // Nothing is reported while locked: there is no authorized session to report with
    if (reason === 'activation_required') return;
    const now = Date.now();
    const last = this.recentDomainBlocks.get(host) || 0;
    if (now - last < 10_000) return;
    this.recentDomainBlocks.set(host, now);

    this.forwardAuditEvent({
      site: host,
      rule_id: RULE_FOR_REASON[reason],
      category: 'UNAUTHORIZED_TOOL',
      severity: reason === 'policy' ? 'CRITICAL' : 'HIGH',
      action: 'BLOCK',
      outcome: 'navigation_blocked',
      prompt:
        reason === 'policy'
          ? `Navigation to ${host} blocked by website policy.`
          : `Navigation to ${host} blocked: AI tool not approved by the organization.`,
    });
  }

  /**
   * Logs a website-category block once per category every 10 seconds. The site's address is not
   * known to the extension here (the browser blocks it before any page runs) and is not reported:
   * only the category is.
   */
  private recordCategoryBlock(category: string) {
    if (!this.authorized()) return;
    const key = `category:${category}`;
    const now = Date.now();
    if (now - (this.recentDomainBlocks.get(key) || 0) < 10_000) return;
    this.recentDomainBlocks.set(key, now);
    const label = CATEGORY_LABELS[category]?.title || 'Website blocked';
    this.forwardAuditEvent({
      site: `${category} website`,
      rule_id: `dlp.category.${category}`,
      category: 'WEB_FILTER',
      severity: category === 'malware' ? 'HIGH' : 'MEDIUM',
      action: 'BLOCK',
      outcome: 'navigation_blocked',
      prompt: `${label} (website category: ${category}).`,
    });
  }

  private async getUserStatus(): Promise<string> {
    if (this.userStatusCache && Date.now() - this.userStatusCache.fetchedAt < USER_STATUS_TTL_MS) {
      return this.userStatusCache.status;
    }
    const stored = await chrome.storage.local.get(['userStatus']);
    let status: string = stored.userStatus || 'ACTIVE';
    if (this.authorized() && this.activation) {
      try {
        const res = await this.apiFetch(`/api/v1/events/users/${encodeURIComponent(this.activation.email)}/status`);
        if (res.ok) {
          const data = await res.json();
          if (data && data.status) {
            status = data.status;
            await chrome.storage.local.set({ userStatus: status });
          }
        }
      } catch {
        // Keep the last known status
      }
    }
    this.userStatusCache = { status, fetchedAt: Date.now() };
    return status;
  }

  private buildPayload(event: SecurityEventPayload) {
    return {
      site: event.site,
      rule_id: event.rule_id,
      category: event.category,
      severity: event.severity,
      action: event.action,
      outcome: event.outcome,
      user_id: this.activation?.email,
      prompt: event.prompt,
      justification: event.justification ? String(event.justification).slice(0, 500) : undefined,
      extension_version: EXTENSION_VERSION,
      policy_version: this.syncState.policy_version,
      // Same id on every retry or offline replay, so the server stores and meters the event once
      client_event_id: crypto.randomUUID().replace(/-/g, ''),
    };
  }

  private async postEvent(payload: any): Promise<boolean> {
    if (!this.authorized()) return false;
    try {
      const res = await this.apiFetch('/api/v1/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      // 4xx other than rate limiting / auth will never succeed on retry; drop those
      return res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 401 && res.status !== 403);
    } catch {
      return false;
    }
  }

  private async forwardAuditEvent(event: SecurityEventPayload) {
    const payload = this.buildPayload(event);
    const sent = await this.postEvent(payload);
    if (!sent) {
      // Keep the event and retry after the next successful sync
      const stored = await chrome.storage.local.get(['eventQueue']);
      const queue: any[] = Array.isArray(stored.eventQueue) ? stored.eventQueue : [];
      queue.push(payload);
      await chrome.storage.local.set({ eventQueue: queue.slice(-MAX_QUEUED_EVENTS) });
    }
  }

  private async flushEventQueue() {
    const stored = await chrome.storage.local.get(['eventQueue']);
    const queue: any[] = Array.isArray(stored.eventQueue) ? stored.eventQueue : [];
    if (!queue.length) return;
    const remaining: any[] = [];
    for (const payload of queue) {
      if (!(await this.postEvent(payload))) remaining.push(payload);
    }
    await chrome.storage.local.set({ eventQueue: remaining });
  }

  private broadcastPoliciesUpdated() {
    const authorized = this.authorized();
    const paused = this.paused();
    chrome.tabs.query({}, (tabs: chrome.tabs.Tab[]) => {
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs
            .sendMessage(tab.id, {
              type: 'POLICIES_UPDATED',
              authorized,
              checks_paused: paused,
              policies: authorized ? this.syncState.policies : [],
              keywords: this.syncState.keywords,
              settings: this.syncState.settings,
            })
            .catch(() => {
              // Tab doesn't have content script
            });
        }
      }
    });
  }
}

new BackgroundService();
