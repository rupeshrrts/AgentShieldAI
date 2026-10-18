/// <reference types="chrome" />
/**
 * AgentShield Content Script
 *
 * Runs on supported AI sites and enforces organization policy BEFORE data leaves the page:
 *  - Prompt submissions (Enter, Ctrl/Cmd+Enter, send-button clicks, form submits)
 *  - File uploads (file picker, drag-and-drop, pasted files); text files are scanned too
 *
 * Decisions: BLOCK (stopped), REDACT (masked, then sent), WARN (sent only after the employee
 * confirms), MONITOR (sent, violation recorded), ALLOW (sent).
 * A confirmed prompt is approved only for its exact text for a few seconds, so dismissing or
 * confirming one alert never lets a different prompt through unchecked.
 */
import { ChatGPTAdapter } from './adapters/chatgpt';
import { LocalDetector } from './detector';
import { AgentShieldOverlay } from './overlay';
import {
  ExtensionSettings,
  PolicyAction,
  PolicyEvaluationResult,
  PolicyRule,
  SecurityEventPayload,
} from '../shared/types';
import { ACTION_PRIORITY, actionForRule, evaluateFindings, RULE_LABELS } from '../shared/policy';

const APPROVAL_TTL_MS = 5000;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const TEXT_FILE_EXTENSIONS = /\.(txt|csv|tsv|md|json|xml|log|ya?ml|ini|conf|cfg|env|sql|py|js|ts|tsx|jsx|java|cs|go|rb|php|c|cpp|h|sh|ps1|pem|key|properties|html?)$/i;

type SubmitMethod = 'keyboard' | 'button' | 'form';

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The element an event is about. Event targets can also be the document, the window or a
 * text node (sites dispatch keyboard shortcuts on document/window), which have no .closest().
 */
function asElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) return target;
  if (target instanceof Node && target.parentElement) return target.parentElement;
  return null;
}

/** False once the extension has been reloaded/updated while this tab stayed open. */
function extensionAlive(): boolean {
  try {
    return Boolean(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

class ContentController {
  private adapter: ChatGPTAdapter;
  private detector: LocalDetector;
  private overlay!: AgentShieldOverlay; // created only on supported AI sites
  private activePolicies: PolicyRule[] = [];
  private settings: ExtensionSettings = {
    store_clean_prompt_text: false,
    store_violation_prompt_text: true,
    block_unapproved_ai: false,
  };
  private userStatus: string = 'ACTIVE'; // ACTIVE, WARNED, RESTRICTED, SUSPENDED
  // Set only from the service worker's answer (never from storage): false until it confirms a live session
  private authorized = false;
  // Free plan with this month's prompt checks used up: AI sites stay usable, prompts are not inspected (or metered)
  private checksPaused = false;
  private approved: { text: string; until: number } | null = null;
  private approvedFiles = new WeakSet<File>();
  private pendingFileChecks = new WeakSet<EventTarget>();

  constructor() {
    this.adapter = new ChatGPTAdapter();
    this.detector = new LocalDetector();
    if (!this.adapter.isSupportedSite()) {
      return; // Not an AI site: no badge, no listeners
    }
    this.overlay = new AgentShieldOverlay();
    // Attach listeners synchronously, at document_start, on window in the capture phase:
    // listeners on the same target and phase run in registration order, so these run
    // before any handler the AI site registers later. Nothing is sent until the service
    // worker confirms this browser is activated and the organization's rules have loaded.
    this.attachSubmitInterception();
    this.attachFileInterception();
    this.init();
  }

  private host(): string {
    return window.location.hostname;
  }

  private async init() {
    try {
      const stored = await chrome.storage.local.get(['userStatus']);
      if (stored && stored.userStatus) {
        this.userStatus = stored.userStatus;
      }
    } catch (e) {}

    await this.loadPolicies();
    this.syncUserStatus();

    try {
      chrome.runtime.onMessage.addListener((msg, sender) => {
        if (sender.id !== chrome.runtime.id) return;
        if (msg.type === 'POLICIES_UPDATED') {
          this.applySync(msg);
        }
      });
    } catch (e) {
      // Extension was reloaded before this page finished loading
    }

    const timer = setInterval(() => {
      // After the extension is reloaded or updated, scripts left in open tabs lose access to
      // the extension APIs. Stop quietly; the refreshed tab gets the new version.
      if (!extensionAlive()) {
        clearInterval(timer);
        return;
      }
      this.checkUiAvailability();
      this.syncUserStatus();
    }, 5000);
    this.checkUiAvailability();
  }

  // ---------------------------------------------------------------- policy state

  /** Asks the service worker (which holds the device session) for activation and governance status. */
  private syncUserStatus() {
    try {
      chrome.runtime.sendMessage({ type: 'GET_USER_STATUS' }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res && typeof res.authorized === 'boolean') {
          if (res.authorized && !this.authorized) this.loadPolicies();
          this.authorized = res.authorized;
          this.checksPaused = res.authorized && res.checks_paused === true;
        }
        if (res && res.status) {
          this.userStatus = res.status;
        }
      });
    } catch (e) {
      // Extension reloaded: keep the last known status
    }
  }

  private applySync(data: { authorized?: boolean; checks_paused?: boolean; policies?: PolicyRule[]; keywords?: string[]; settings?: ExtensionSettings }) {
    if (typeof data.authorized === 'boolean') {
      this.authorized = data.authorized;
      this.checksPaused = data.authorized && data.checks_paused === true;
      this.checkUiAvailability();
    }
    if (Array.isArray(data.policies)) {
      this.activePolicies = data.policies;
    }
    // Keywords stay on the built-in defaults until the first successful sync with the dashboard
    if (Array.isArray(data.keywords)) {
      this.detector.setKeywords(data.keywords);
    }
    if (data.settings) {
      this.settings = { ...this.settings, ...data.settings };
    }
  }

  /** Rules and the activation state come from the service worker, never straight from storage. */
  private async loadPolicies() {
    try {
      chrome.runtime.sendMessage({ type: 'GET_POLICIES' }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res) this.applySync(res);
      });
    } catch (e) {
      // Extension reloaded: stay locked
    }
  }

  private checkUiAvailability() {
    if (!document.body) return;
    const promptEl = this.adapter.findPromptElement();
    this.overlay.updateProtectionStatus(Boolean(promptEl), promptEl ? undefined : 'Prompt box not found on this page.', this.checksPaused);
  }

  private evaluateText(text: string): PolicyEvaluationResult {
    const result = evaluateFindings(this.detector.detect(text), this.activePolicies, this.host(), this.userStatus);
    if (result.action === 'REDACT') {
      result.redacted_text = this.detector.redact(text, result.findings);
    }
    return result;
  }

  // ---------------------------------------------------------------- prompt submission

  private isApproved(text: string): boolean {
    if (!this.approved) return false;
    if (Date.now() > this.approved.until) {
      this.approved = null;
      return false;
    }
    if (normalizeText(text) === this.approved.text) {
      this.approved = null; // one use only
      return true;
    }
    return false;
  }

  private approve(text: string) {
    this.approved = { text: normalizeText(text), until: Date.now() + APPROVAL_TTL_MS };
  }

  private isInPromptArea(target: HTMLElement | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const promptEl = this.adapter.findPromptElement();
    if (promptEl && (promptEl === target || promptEl.contains(target))) return true;
    return Boolean(
      target.isContentEditable ||
        target.closest('[contenteditable="true"]') ||
        target.closest('.ProseMirror') ||
        target instanceof HTMLTextAreaElement
    );
  }

  /**
   * Common gate for every submission path. Returns true if the event must be stopped.
   */
  private gateSubmission(e: Event, promptText: string, method: SubmitMethod): boolean {
    // While an AgentShield dialog is open, nothing is submitted from the page
    if (this.overlay.isOpen()) return true;
    if (!promptText.trim()) return false;
    // Backup for the network block: nothing is sent from an AI site until this browser is activated
    if (!this.authorized) {
      void this.showActivationRequired('Prompt not sent');
      return true;
    }
    // Free monthly prompt checks used up: the prompt goes through unchecked until they reset or the plan changes
    if (this.checksPaused) return false;
    if (this.isApproved(promptText)) return false;

    const evaluation = this.evaluateText(promptText);
    if (evaluation.action === 'ALLOW') {
      this.logCleanPrompt(promptText);
      return false;
    }
    if (evaluation.action === 'MONITOR') {
      this.reportPromptEvent(evaluation, promptText, 'MONITOR', 'monitored');
      return false;
    }
    void this.handlePolicyAction(evaluation, promptText, method);
    return true;
  }

  private showActivationRequired(title: string): Promise<void> {
    return this.overlay.showBlockModal(
      {
        action: 'BLOCK',
        primary_rule_id: 'access.activation_required',
        highest_severity: 'HIGH',
        reason: 'AgentShield is not activated in this browser, so AI tools are blocked. Generate an activation code in your AgentShield dashboard, then click the AgentShield icon and paste it.',
        findings: [],
        needs_confirmation: false,
      },
      { title, subtitle: 'Activation required' }
    );
  }

  private stop(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  private attachSubmitInterception() {
    // 1. Keyboard: Enter or Ctrl/Cmd+Enter (Shift+Enter is a new line; IME composition is ignored)
    window.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
        // A key event aimed at the document/window still counts if the prompt box has focus
        const target = asElement(e.target) || asElement(document.activeElement);
        if (target?.closest('.agentshield-modal-backdrop')) return;
        if (!this.isInPromptArea(target) && !(target instanceof HTMLInputElement && target.type === 'text')) return;

        let promptText = this.adapter.getPromptText();
        if (!promptText.trim() && target) {
          promptText = target.innerText || target.textContent || (target as any).value || '';
        }
        if (this.gateSubmission(e, promptText, 'keyboard')) this.stop(e);
      },
      true // capture phase: runs before the site's own handlers
    );

    // 2. Send-button clicks
    window.addEventListener(
      'click',
      (e: MouseEvent) => {
        const target = asElement(e.target);
        if (!target || target.closest('.agentshield-modal-backdrop')) return;
        const targetBtn = target.closest('button') as HTMLElement | null;
        const submitBtn = this.adapter.findSubmitButton();
        const isSubmitClick =
          (submitBtn && (submitBtn === target || submitBtn.contains(target))) ||
          (targetBtn && this.adapter.isSubmitButton(targetBtn));
        if (!isSubmitClick) return;

        if (this.gateSubmission(e, this.adapter.getPromptText(), 'button')) this.stop(e);
      },
      true
    );

    // 3. Form submissions that contain the prompt box
    window.addEventListener(
      'submit',
      (e: Event) => {
        const form = e.target;
        const promptEl = this.adapter.findPromptElement();
        if (!(form instanceof HTMLFormElement) || !promptEl || !form.contains(promptEl)) return;
        if (this.gateSubmission(e, this.adapter.getPromptText(), 'form')) this.stop(e);
      },
      true
    );
  }

  private async handlePolicyAction(result: PolicyEvaluationResult, originalText: string, method: SubmitMethod) {
    if (result.action === 'BLOCK') {
      this.reportPromptEvent(result, originalText, 'BLOCK', 'blocked');
      await this.overlay.showBlockModal(result);
      return;
    }

    if (result.action === 'WARN') {
      const decision = await this.overlay.showWarnModal(result);
      this.reportPromptEvent(
        result,
        originalText,
        'WARN',
        decision.proceed ? 'warned_and_confirmed' : 'warned_and_cancelled',
        decision.justification
      );
      if (decision.proceed) {
        this.approve(originalText);
        this.resubmit(method);
      }
      return;
    }

    if (result.action === 'REDACT') {
      const redactedText = result.redacted_text || this.detector.redact(originalText, result.findings);
      const confirmed = await this.overlay.showRedactModal(result, redactedText);
      if (!confirmed) return;

      this.adapter.setPromptText(redactedText);
      // Verify the page really holds the masked text before anything is sent
      await new Promise((r) => setTimeout(r, 50));
      const current = this.adapter.getPromptText();
      if (normalizeText(current) !== normalizeText(redactedText)) {
        this.reportPromptEvent(result, originalText, 'BLOCK', 'redaction_failed_blocked');
        await this.overlay.showBlockModal(
          { ...result, action: 'BLOCK', reason: 'AgentShield could not mask the text automatically on this site, so it was not sent.' },
          { title: 'Please remove the sensitive terms', subtitle: 'Edit the prompt yourself, then send it again.' }
        );
        return;
      }
      this.reportPromptEvent(result, redactedText, 'REDACT', 'redacted_and_submitted');
      this.approve(redactedText);
      this.resubmit(method);
    }
  }

  /** Re-sends the approved prompt the way the employee originally tried to. */
  private resubmit(method: SubmitMethod) {
    setTimeout(() => {
      const btn = this.adapter.findSubmitButton();
      if (btn && method !== 'keyboard') {
        btn.click();
        return;
      }
      const el = this.adapter.findPromptElement();
      if (el) {
        el.focus();
        el.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })
        );
      } else if (btn) {
        btn.click();
      }
    }, 150);
  }

  // ---------------------------------------------------------------- file uploads

  private attachFileInterception() {
    const onFileInput = (e: Event) => {
      const input = e.target;
      if (!this.adapter.isFileInput(input)) return;
      const files = Array.from(input.files || []);
      if (!files.length || files.every((f) => this.approvedFiles.has(f))) return;

      this.stop(e);
      if (this.pendingFileChecks.has(input)) return; // 'input' and 'change' fire together
      this.pendingFileChecks.add(input);
      void this.checkFiles(files).then((allowed) => {
        this.pendingFileChecks.delete(input);
        if (allowed) {
          files.forEach((f) => this.approvedFiles.add(f));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          input.value = '';
        }
      });
    };
    window.addEventListener('input', onFileInput, true);
    window.addEventListener('change', onFileInput, true);

    window.addEventListener(
      'drop',
      (e: DragEvent) => {
        const files = Array.from(e.dataTransfer?.files || []);
        if (!files.length || files.every((f) => this.approvedFiles.has(f))) return;
        this.stop(e);
        const target = e.target as EventTarget;
        const { clientX, clientY } = e;
        void this.checkFiles(files).then((allowed) => {
          if (!allowed) return;
          files.forEach((f) => this.approvedFiles.add(f));
          const dt = new DataTransfer();
          files.forEach((f) => dt.items.add(f));
          target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX, clientY }));
        });
      },
      true
    );

    window.addEventListener(
      'paste',
      (e: ClipboardEvent) => {
        const files = Array.from(e.clipboardData?.files || []);
        if (!files.length || files.every((f) => this.approvedFiles.has(f))) return;
        this.stop(e);
        const target = e.target as EventTarget;
        void this.checkFiles(files).then((allowed) => {
          if (!allowed) return;
          files.forEach((f) => this.approvedFiles.add(f));
          const dt = new DataTransfer();
          files.forEach((f) => dt.items.add(f));
          target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        });
      },
      true
    );
  }

  private isTextFile(file: File): boolean {
    return (
      file.size <= MAX_SCAN_BYTES &&
      (file.type.startsWith('text/') || /json|xml|csv|yaml|javascript|x-sh/.test(file.type) || TEXT_FILE_EXTENSIONS.test(file.name))
    );
  }

  /**
   * Decides whether files may be uploaded: the 'file.upload' policy, plus the content
   * rules applied to text files. Returns true if the upload may continue.
   */
  private async checkFiles(files: File[]): Promise<boolean> {
    if (!this.authorized) {
      await this.showActivationRequired('File upload blocked');
      return false;
    }
    const host = this.host();
    const fileRule = actionForRule('file.upload', 'FILE', 'MEDIUM', this.activePolicies, host);
    const fileAction: PolicyAction = this.userStatus === 'SUSPENDED' ? 'BLOCK' : fileRule ? fileRule.action : 'ALLOW';

    // Scan text-based files with the same rules as prompts
    let contentResult: PolicyEvaluationResult | null = null;
    const scanned: string[] = [];
    for (const file of files) {
      if (!this.isTextFile(file)) continue;
      try {
        const result = this.evaluateText(await file.text());
        scanned.push(file.name);
        if (!contentResult || ACTION_PRIORITY[result.action] > ACTION_PRIORITY[contentResult.action]) {
          contentResult = result;
        }
      } catch {
        // Unreadable file: only the file.upload policy applies
      }
    }
    // Files cannot be masked automatically, so a REDACT match blocks the upload
    let contentAction: PolicyAction = contentResult ? contentResult.action : 'ALLOW';
    if (contentAction === 'REDACT') contentAction = 'BLOCK';

    let action: PolicyAction = ACTION_PRIORITY[contentAction] > ACTION_PRIORITY[fileAction] ? contentAction : fileAction;
    if (this.userStatus === 'RESTRICTED' && action === 'WARN') action = 'BLOCK';

    const names = files.map((f) => `${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB)`).join(', ');
    const uninspected = files.filter((f) => !scanned.includes(f.name)).map((f) => f.name);
    const useContent = Boolean(contentResult) && ACTION_PRIORITY[contentAction] >= ACTION_PRIORITY[fileAction] && contentAction !== 'ALLOW';

    const result: PolicyEvaluationResult = useContent
      ? {
          ...(contentResult as PolicyEvaluationResult),
          action,
          reason: `${RULE_LABELS[contentResult!.primary_rule_id || ''] || 'Sensitive data'} found inside ${scanned.join(', ')}.`,
        }
      : {
          action,
          primary_rule_id: 'file.upload',
          highest_severity: fileRule?.severity || 'MEDIUM',
          reason:
            action === 'BLOCK'
              ? 'Your organization does not allow uploading files to AI tools.'
              : 'You are uploading a file to an AI tool.' +
                (uninspected.length ? ' AgentShield cannot read inside PDF, Office or image files, so check them yourself.' : ''),
          findings: [],
          needs_confirmation: action === 'WARN',
        };

    const report = (outcome: string, act: PolicyAction, justification?: string) =>
      this.sendAuditEvent({
        site: host,
        rule_id: result.primary_rule_id || 'file.upload',
        category: useContent ? (result.findings[0]?.category || 'FILE') : 'FILE',
        severity: result.highest_severity || 'MEDIUM',
        action: act,
        outcome,
        prompt: this.settings.store_violation_prompt_text ? `File upload: ${names}` : undefined,
        justification,
      });

    if (action === 'ALLOW') return true;
    if (action === 'MONITOR') {
      report('file_monitored', 'MONITOR');
      return true;
    }
    if (action === 'BLOCK') {
      report('file_blocked', 'BLOCK');
      await this.overlay.showBlockModal(result, { title: 'File upload blocked', subtitle: names });
      return false;
    }
    const decision = await this.overlay.showWarnModal(result, { title: 'Check this file before uploading', subtitle: names });
    report(decision.proceed ? 'file_warned_and_confirmed' : 'file_warned_and_cancelled', 'WARN', decision.justification);
    return decision.proceed;
  }

  // ---------------------------------------------------------------- audit events

  /** Sends a prompt event. Only masked text leaves the browser, and only if the organization stores prompt text. */
  private reportPromptEvent(
    result: PolicyEvaluationResult,
    text: string,
    action: PolicyAction,
    outcome: string,
    justification?: string
  ) {
    const ruleId = result.primary_rule_id || 'unknown.rule';
    const finding = result.findings.find((f) => f.rule_id === ruleId) || result.findings[0];
    this.sendAuditEvent({
      site: this.host(),
      rule_id: ruleId,
      category: finding ? finding.category : 'SECRET',
      severity: result.highest_severity || 'HIGH',
      action,
      outcome,
      prompt: this.settings.store_violation_prompt_text ? this.detector.maskSecretsForAudit(text) : undefined,
      justification,
    });
  }

  /** Records an allowed prompt for usage statistics; its text is included only if the organization opted in. */
  private logCleanPrompt(promptText: string) {
    this.sendAuditEvent({
      site: this.host(),
      rule_id: 'general.clean_prompt',
      category: 'PROMPT_LOG',
      severity: 'LOW',
      action: 'ALLOW',
      outcome: 'allowed',
      prompt: this.settings.store_clean_prompt_text ? this.detector.maskSecretsForAudit(promptText) : undefined,
    });
  }

  private lastDispatchedKey = '';
  private lastDispatchedTime = 0;

  private sendAuditEvent(payload: SecurityEventPayload) {
    const now = Date.now();
    const key = `${payload.action}_${payload.rule_id}_${payload.outcome}_${payload.prompt || ''}`;
    if (this.lastDispatchedKey === key && now - this.lastDispatchedTime < 2000) return;
    this.lastDispatchedKey = key;
    this.lastDispatchedTime = now;

    // The service worker adds the employee ID and device key, and queues the event if offline
    try {
      chrome.runtime.sendMessage({ type: 'RECORD_SECURITY_EVENT', event: payload }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      console.warn('[AgentShield] Could not hand audit event to the service worker:', e);
    }
  }
}

// Start content controller with single-execution guard
if (!(window as any).__agentShieldContentInitialized) {
  (window as any).__agentShieldContentInitialized = true;
  new ContentController();
}
