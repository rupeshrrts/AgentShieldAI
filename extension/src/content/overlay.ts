/**
 * AgentShield In-Page Overlay and Modal Component
 * Accessible security alerts that explain what was found and what to do next.
 */
import { PolicyEvaluationResult } from '../shared/types';
import { RULE_ADVICE, RULE_LABELS } from '../shared/policy';

export interface ModalText {
  title?: string;
  subtitle?: string;
}

export interface WarnDecision {
  proceed: boolean;
}

type Kind = 'block' | 'warn' | 'redact';

const PRIVACY_NOTE =
  'Checked on this computer. Your security team receives the policy decision without the message or file contents.';

export class AgentShieldOverlay {
  private overlayRoot: HTMLElement | null = null;
  private badgeRoot: HTMLElement | null = null;

  constructor(showBadge: boolean) {
    if (!showBadge) return;
    // The content script starts at document_start, before <body> exists
    if (document.body) {
      this.createProtectionBadge();
    } else {
      document.addEventListener('DOMContentLoaded', () => this.createProtectionBadge(), { once: true });
    }
  }

  public updateProtectionStatus(active: boolean, reason?: string, paused = false) {
    if (!this.badgeRoot) return;
    const dot = this.badgeRoot.querySelector('.agentshield-badge-dot');
    const text = this.badgeRoot.querySelector('.agentshield-badge-text');

    if (paused) {
      if (dot) dot.className = 'agentshield-badge-dot agentshield-badge-unavailable';
      if (text) text.textContent = 'Protection paused';
      this.badgeRoot.title = 'This month\'s free prompt checks are used, so prompts are not checked. They resume on the 1st, or upgrade in the AgentShield portal.';
    } else if (active) {
      if (dot) dot.className = 'agentshield-badge-dot agentshield-badge-active';
      if (text) text.textContent = 'AgentShield Protected';
      this.badgeRoot.title = 'AgentShield is checking prompts and file uploads on this page.';
    } else {
      if (dot) dot.className = 'agentshield-badge-dot agentshield-badge-unavailable';
      if (text) text.textContent = 'Not Protected';
      this.badgeRoot.title = reason || 'AgentShield cannot find the prompt box on this page, so prompts are not being checked.';
    }
  }

  private createProtectionBadge() {
    if (document.getElementById('agentshield-status-badge')) return;

    const badge = document.createElement('div');
    badge.id = 'agentshield-status-badge';
    badge.className = 'agentshield-badge-container';
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-live', 'polite');
    badge.innerHTML = `
      <div class="agentshield-badge-pill">
        <svg class="agentshield-badge-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 2.18l7 3.12v4.7c0 4.54-3.14 8.78-7 9.88-3.86-1.1-7-5.34-7-9.88V6.3l7-3.12z"/>
        </svg>
        <span class="agentshield-badge-dot agentshield-badge-active"></span>
        <span class="agentshield-badge-text">AgentShield Protected</span>
      </div>
    `;
    (document.body || document.documentElement).appendChild(badge);
    this.badgeRoot = badge;
  }

  /** Short, plain-language list of what was detected, e.g. "An email address, A phone number". */
  private findingsSummary(result: PolicyEvaluationResult): string {
    const labels = Array.from(new Set(result.findings.map((f) => RULE_LABELS[f.rule_id] || f.rule_id)));
    return labels.join(', ');
  }

  /** Brand bar + coloured status band, like a corporate DLP notice. */
  private header(kind: Kind, title: string, subtitle: string): string {
    const icons: Record<Kind, string> = {
      block: '<circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/>',
      warn: '<path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9.5" x2="12" y2="13.5"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
      redact: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    };
    const notice: Record<Kind, string> = { block: 'Action blocked', warn: 'Confirmation required', redact: 'Masking required' };
    return `
      <div class="agentshield-brandbar">
        <img class="agentshield-brand-logo" src="${chrome.runtime.getURL('icons/icon-48.png')}" alt="" />
        <span class="agentshield-brand-name">AgentShield</span>
        <span class="agentshield-brand-sub">Data Protection</span>
        <span class="agentshield-brand-notice">Security policy notice</span>
      </div>
      <div class="agentshield-status agentshield-status-${kind}">
        <div class="agentshield-status-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${icons[kind]}</svg>
        </div>
        <div class="agentshield-status-text">
          <div class="agentshield-status-kicker">${notice[kind]}</div>
          <h3 id="agentshield-modal-title" class="agentshield-modal-title">${escapeHtml(title)}</h3>
          <p class="agentshield-modal-subtitle">${escapeHtml(subtitle)}</p>
        </div>
      </div>`;
  }

  /** Incident facts (what, which policy, severity, where, when) and the next step. */
  private details(result: PolicyEvaluationResult): string {
    const rule = result.primary_rule_id || 'policy';
    const sev = (result.highest_severity || 'MEDIUM').toUpperCase();
    const sevLabel = sev.charAt(0) + sev.slice(1).toLowerCase();
    const advice = RULE_ADVICE[rule];
    const found = this.findingsSummary(result);
    const when = new Date().toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const row = (label: string, value: string) =>
      `<div class="agentshield-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
    return `
      <p id="agentshield-modal-desc" class="agentshield-lead">${escapeHtml(result.reason)}</p>
      <dl class="agentshield-facts">
        ${found ? row('Detected', escapeHtml(found)) : ''}
        ${row('Policy', `<code class="agentshield-code">${escapeHtml(rule)}</code>`)}
        ${row('Severity', `<span class="agentshield-sev agentshield-sev-${sev.toLowerCase()}"><i></i>${escapeHtml(sevLabel)}</span>`)}
        ${row('Website', escapeHtml(location.hostname || '-'))}
        ${row('Time', escapeHtml(when))}
      </dl>
      ${advice ? `<div class="agentshield-next"><div class="agentshield-next-title">What to do next</div><p>${escapeHtml(advice)}</p></div>` : ''}`;
  }

  private footer(buttons: string): string {
    return `
      <div class="agentshield-modal-footer">
        <p class="agentshield-footnote">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
          <span>${escapeHtml(PRIVACY_NOTE)}</span>
        </p>
        <div class="agentshield-actions">${buttons}</div>
      </div>`;
  }

  private mount(html: string): HTMLElement {
    this.removeExistingModal();
    const modal = document.createElement('div');
    modal.className = 'agentshield-modal-backdrop';
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'agentshield-modal-title');
    modal.setAttribute('aria-describedby', 'agentshield-modal-desc');
    modal.innerHTML = html;
    (document.body || document.documentElement).appendChild(modal);
    this.overlayRoot = modal;
    return modal;
  }

  public showBlockModal(result: PolicyEvaluationResult, text?: ModalText): Promise<void>;
  public showBlockModal(result: PolicyEvaluationResult, text: ModalText | undefined, preview: string | undefined): Promise<boolean>;
  public showBlockModal(result: PolicyEvaluationResult, text: ModalText = {}, preview?: string): Promise<boolean | void> {
    return new Promise((resolve) => {
      const modal = this.mount(`
        <div class="agentshield-modal-box agentshield-modal-block">
          ${this.header('block', text.title || 'Prompt blocked by security policy', text.subtitle || 'Your message was not sent to this AI tool.')}
          <div class="agentshield-modal-body">${this.details(result)}
            ${preview ? `<div class="agentshield-preview-label">Redacted draft</div><div class="agentshield-code-preview">${escapeHtml(preview)}</div>` : ''}
          </div>
          ${this.footer('<button id="agentshield-block-dismiss" class="agentshield-btn agentshield-btn-danger">Return and edit</button>' +
            (preview ? '<button id="agentshield-block-replace" class="agentshield-btn agentshield-btn-primary">Use redacted draft</button>' : ''))}
        </div>`);
      const close = (replace: boolean) => {
        this.removeExistingModal();
        resolve(replace);
      };
      const btn = modal.querySelector<HTMLButtonElement>('#agentshield-block-dismiss');
      btn?.focus();
      btn?.addEventListener('click', () => close(false));
      modal.querySelector('#agentshield-block-replace')?.addEventListener('click', () => close(true));
      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close(false);
      });
    });
  }

  public showWarnModal(result: PolicyEvaluationResult, text: ModalText = {}): Promise<WarnDecision> {
    return new Promise((resolve) => {
      const modal = this.mount(`
        <div class="agentshield-modal-box agentshield-modal-warn">
          ${this.header('warn', text.title || 'Sensitive information detected', text.subtitle || 'Review before sending. Your message has not been sent yet.')}
          <div class="agentshield-modal-body">
            ${this.details(result)}
          </div>
          ${this.footer(`
            <button id="agentshield-warn-cancel" class="agentshield-btn agentshield-btn-secondary">Cancel and edit</button>
            <button id="agentshield-warn-proceed" class="agentshield-btn agentshield-btn-warning">Send anyway</button>`)}
        </div>`);
      const done = (proceed: boolean) => {
        this.removeExistingModal();
        resolve({ proceed });
      };
      const cancelBtn = modal.querySelector<HTMLButtonElement>('#agentshield-warn-cancel');
      cancelBtn?.focus();
      cancelBtn?.addEventListener('click', () => done(false));
      modal.querySelector('#agentshield-warn-proceed')?.addEventListener('click', () => done(true));
      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') done(false);
      });
    });
  }

  public showRedactModal(result: PolicyEvaluationResult, redactedText: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = this.mount(`
        <div class="agentshield-modal-box agentshield-modal-redact">
          ${this.header('redact', 'Sensitive terms will be masked', 'Your organization requires these terms to be replaced before sending.')}
          <div class="agentshield-modal-body">
            ${this.details(result)}
            <label class="agentshield-preview-label">Message that will be sent</label>
            <div class="agentshield-code-preview">${escapeHtml(redactedText)}</div>
          </div>
          ${this.footer(`
            <button id="agentshield-redact-cancel" class="agentshield-btn agentshield-btn-secondary">Cancel</button>
            <button id="agentshield-redact-apply" class="agentshield-btn agentshield-btn-primary">Mask and send</button>`)}
        </div>`);
      const done = (ok: boolean) => {
        this.removeExistingModal();
        resolve(ok);
      };
      const applyBtn = modal.querySelector<HTMLButtonElement>('#agentshield-redact-apply');
      applyBtn?.focus();
      modal.querySelector('#agentshield-redact-cancel')?.addEventListener('click', () => done(false));
      applyBtn?.addEventListener('click', () => done(true));
      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') done(false);
      });
    });
  }

  /** True while an AgentShield dialog is open (submissions are held until it is answered). */
  public isOpen(): boolean {
    return Boolean(this.overlayRoot && this.overlayRoot.isConnected);
  }

  private removeExistingModal() {
    if (this.overlayRoot) {
      this.overlayRoot.remove();
      this.overlayRoot = null;
    }
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.innerText = str;
  return div.innerHTML;
}
