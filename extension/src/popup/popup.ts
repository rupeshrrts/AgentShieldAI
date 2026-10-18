/// <reference types="chrome" />
/**
 * AgentShield Popup Script
 *
 * Locked view: "Activation Required" with the activation code field and live connection
 * status. Activated view: shown only when the service worker reports a live session that
 * the server issued; nothing here can unlock the extension by itself.
 */

const BUSY_STATES = new Set(['CONNECTING', 'AUTHENTICATING']);

const PLAN_NAMES: Record<string, string> = {
  monthly: 'Monthly plan',
  six_month: '6-month plan',
  annual: 'Annual plan',
  internal: 'Internal licence',
};

let justActivated = false;

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setText(id: string, text: string) {
  const e = el(id);
  if (e) e.textContent = text;
}

function openDashboard(url: string) {
  if (url) chrome.tabs.create({ url });
}

let dashboardUrl = '';

document.addEventListener('DOMContentLoaded', () => {
  setText('ext-version', 'v' + chrome.runtime.getManifest().version);
  refreshStatus();
  // Follow the state machine while the popup is open (connecting -> authorized, etc.)
  const timer = setInterval(refreshStatus, 1500);
  window.addEventListener('unload', () => clearInterval(timer));

  for (const id of ['open-dashboard-1', 'open-dashboard-2', 'upgrade-btn', 'renew-link', 'paused-upgrade']) {
    el(id)?.addEventListener('click', (e) => {
      e.preventDefault();
      openDashboard(dashboardUrl);
    });
  }

  el('recheck-btn')?.addEventListener('click', () => {
    const btn = el<HTMLButtonElement>('recheck-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Checking...';
    }
    chrome.runtime.sendMessage({ type: 'RETRY' }, () => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Check again';
      }
      refreshStatus();
    });
  });

  el('activate-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = el<HTMLTextAreaElement>('act-code')?.value || '';
    const btn = el<HTMLButtonElement>('act-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Verifying...';
    }
    chrome.runtime.sendMessage({ type: 'ACTIVATE', code }, (res) => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Connect and verify';
      }
      if (chrome.runtime.lastError) {
        setText('conn-msg', 'AgentShield was updated but not reloaded. Open chrome://extensions, reload AgentShield, then try again.');
        return;
      }
      if (res && res.ok && !res.pending) {
        justActivated = true;
        const codeEl = el<HTMLTextAreaElement>('act-code');
        if (codeEl) codeEl.value = '';
      } else if (res && res.error) {
        setText('conn-msg', res.error);
      }
      refreshStatus();
    });
  });

  el('pc-app-btn')?.addEventListener('click', () => {
    const btn = el<HTMLButtonElement>('pc-app-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Connecting...';
    }
    chrome.runtime.sendMessage({ type: 'CONNECT_VIA_PC' }, (res) => {
      if (btn) btn.disabled = false;
      if (chrome.runtime.lastError) return;
      if (res && res.ok) justActivated = true;
      else if (res && res.pc_app === 'not_connected') {
        setText('pc-app-text', 'Connect this PC in the AgentShield window that just opened. This browser then connects by itself.');
        const t = el('pc-app-text');
        if (t) t.dataset.sticky = '1';
      }
      else if (res && res.error) setText('conn-msg', res.error);
      refreshStatus();
    });
  });

  el('retry-btn')?.addEventListener('click', () => {
    const btn = el<HTMLButtonElement>('retry-btn');
    if (btn) btn.disabled = true;
    chrome.runtime.sendMessage({ type: 'RETRY' }, () => {
      if (btn) btn.disabled = false;
      refreshStatus();
    });
  });

  el('sync-btn')?.addEventListener('click', () => {
    const btn = el<HTMLButtonElement>('sync-btn');
    if (btn) btn.textContent = 'Syncing...';
    chrome.runtime.sendMessage({ type: 'TRIGGER_SYNC' }, () => {
      if (btn) btn.textContent = 'Sync policies';
      refreshStatus();
    });
  });

  el('signout-btn')?.addEventListener('click', () => {
    if (!confirm('Sign out this browser? AI tools will be blocked until it is activated again with a new code.')) return;
    chrome.runtime.sendMessage({ type: 'SIGN_OUT' }, () => {
      justActivated = false;
      refreshStatus();
    });
  });
});

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    dashboardUrl = res.dashboard_url || '';

    const authorized = Boolean(res.authorized);
    const state: string = res.auth_state || 'LOCKED';
    const license = res.license || null;
    // A browser that is activated but whose company has no active plan gets the "plan ended" screen
    const planEnded = !authorized && res.activated && (state === 'EXPIRED' || (state === 'REVOKED' && license));
    const locked = el('locked-view');
    const expired = el('expired-view');
    const active = el('active-view');
    if (locked) locked.style.display = authorized || planEnded ? 'none' : 'flex';
    if (expired) expired.style.display = planEnded ? 'flex' : 'none';
    if (active) active.style.display = authorized ? 'flex' : 'none';

    // Free plan with this month's prompt checks used up: connected, but prompts are not checked
    const paused = authorized && res.checks_paused === true;
    const pill = el('status-pill');
    if (pill) pill.className = 'status-pill ' + (paused ? 'paused' : authorized ? 'active' : 'offline');
    setText(
      'status-text',
      paused ? 'Paused' : authorized ? 'Protected' : state === 'PENDING_APPROVAL' ? 'Pending' : state === 'EXPIRED' ? 'Plan ended' : 'Locked'
    );

    if (planEnded) {
      const never = license && license.state === 'NONE';
      setText('expired-title', never ? 'No active plan' : state === 'REVOKED' ? 'Access suspended' : 'Your plan has ended');
      setText('expired-msg', res.auth_message || '');
      setText(
        'expired-date',
        license && license.expiresAt && !never ? `Ended ${new Date(license.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ''
      );
      return;
    }

    if (!authorized) {
      // AgentShield Windows app: offered only when it is installed on this PC
      const pcCard = el('pc-app-card');
      const pcApp: string = res.pc_app || 'unknown';
      if (pcCard) pcCard.style.display = pcApp === 'connected' || pcApp === 'not_connected' || pcApp === 'error' ? 'block' : 'none';
      const pcBtn = el<HTMLButtonElement>('pc-app-btn');
      if (pcBtn && !pcBtn.disabled) pcBtn.textContent = pcApp === 'not_connected' ? 'Connect this PC' : 'Connect this browser';
      const pcText = el('pc-app-text');
      if (pcText && !pcText.dataset.sticky) {
        pcText.textContent =
          res.pc_auto_connect_paused
            ? 'This browser was signed out. Click to connect it again through the AgentShield app.'
            : pcApp === 'not_connected'
            ? 'The AgentShield app is installed but this PC is not connected yet. Connect it once and every browser on this PC connects by itself.'
            : pcApp === 'error'
            ? res.pc_app_message || 'The AgentShield app could not connect this browser.'
            : 'This PC is connected in the AgentShield app. This browser connects by itself in a moment.';
      }
      setText('conn-state', state.replace(/_/g, ' '));
      const dot = el('conn-dot');
      if (dot) dot.className = 'conn-dot' + (BUSY_STATES.has(state) ? ' busy' : '');
      // Keep a specific error from the last activation attempt visible until the state changes
      const msgEl = el('conn-msg');
      if (msgEl && (BUSY_STATES.has(state) || !msgEl.dataset.state || msgEl.dataset.state !== state)) {
        msgEl.textContent = res.auth_message || '';
        msgEl.dataset.state = state;
      }
      const retry = el('retry-btn');
      if (retry) retry.style.display = res.activated && !BUSY_STATES.has(state) ? 'flex' : 'none';
      return;
    }

    const banner = el('success-banner');
    if (banner) banner.style.display = justActivated ? 'block' : 'none';

    // Plan and countdown, as reported by the server
    const isTrial = state === 'TRIAL_ACTIVE';
    const isFree = state === 'FREE_ACTIVE' || state === 'FREE_PAUSED';
    const payg = license?.state === 'CREDITS_ACTIVE';
    setText('plan-name', isTrial ? 'Free trial' : isFree ? 'Free plan' : payg ? 'Pay as you go' : PLAN_NAMES[license?.plan] || 'Subscription');
    const days = license && typeof license.daysLeft === 'number' ? license.daysLeft : null;
    const credits = license && typeof license.credits === 'number' ? license.credits : null;
    const resets = license && typeof license.resetsAt === 'number' ? new Date(license.resetsAt).toLocaleDateString([], { dateStyle: 'medium' }) : '';
    const freeLeft =
      isFree && typeof license?.checkLimit === 'number' && typeof license?.checksThisMonth === 'number'
        ? Math.max(0, license.checkLimit - license.checksThisMonth)
        : null;
    setText('plan-days', isFree ? (freeLeft === null ? '-' : String(freeLeft)) : payg && credits !== null ? String(credits) : days === null ? '∞' : String(days));
    setText('plan-days-label', isFree ? 'free checks left' : payg ? 'credits' : 'days left');
    const pausedBanner = el('paused-banner');
    if (pausedBanner) pausedBanner.style.display = paused ? 'flex' : 'none';
    setText('paused-text', 'Protection paused — free monthly checks used' + (resets ? ' · resumes ' + resets : '') + ' ·');
    setText(
      'plan-ends',
      isFree
        ? resets
          ? 'Resets ' + resets + (credits ? ' · ' + credits + ' bonus checks' : '')
          : 'Every month'
        : payg
        ? 'prompt checks left'
        : license && license.expiresAt
        ? `Ends ${new Date(license.expiresAt).toLocaleDateString([], { dateStyle: 'medium' })}`
        : 'No end date'
    );
    const renew = el('renew-banner');
    if (renew) renew.style.display = days !== null && days <= 7 ? 'flex' : 'none';
    setText('renew-text', isTrial ? `Your free trial ends in ${days} day${days === 1 ? '' : 's'}.` : `Your plan ends in ${days} day${days === 1 ? '' : 's'}.`);
    setText('user-id-val', res.user_email || '-');
    setText('org-name', res.organization_name || '-');
    setText('domain-stats', `${res.blockedDomainsCount ?? 0} Blocked | ${res.allowedDomainsCount ?? 0} Allowed`);
    setText('policy-version', `v${res.policy_version || 1}`);
    setText(
      'last-sync',
      res.last_synced_at ? new Date(res.last_synced_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : 'Never'
    );
    setText(
      'session-exp',
      res.session_expires_at ? new Date(res.session_expires_at).toLocaleTimeString([], { timeStyle: 'short' }) : '-'
    );
    const errorBox = el('sync-error');
    if (errorBox) {
      errorBox.textContent = res.last_error || '';
      errorBox.style.display = res.last_error ? 'block' : 'none';
    }

    const policies = res.policies || [];
    setText('count-block', String(policies.filter((p: any) => p.enabled && p.action === 'BLOCK').length));
    setText('count-warn', String(policies.filter((p: any) => p.enabled && (p.action === 'WARN' || p.action === 'MONITOR')).length));
    setText('count-redact', String(policies.filter((p: any) => p.enabled && p.action === 'REDACT').length));
  });
}
