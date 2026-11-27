/**
 * ChatGPT DOM Adapter
 *
 * Encapsulates CSS selectors and DOM manipulation for ChatGPT and compatible
 * browser-based AI chat interfaces. Handles reading prompt input, updating text
 * for redaction, and locating submit buttons.
 */
// AI sites where prompts and uploads are inspected (domain or any subdomain)
import { SUPPORTED_AI_HOSTS } from '../../shared/domains';

export interface SiteAdapter {
  isSupportedSite(): boolean;
  findPromptElement(): HTMLElement | null;
  getPromptText(submitter?: HTMLElement): string;
  setPromptText(newText: string): boolean;
  findSubmitButton(): HTMLElement | null;
}


export class ChatGPTAdapter implements SiteAdapter {
  private readonly isClaude = /(?:^|\.)claude\.ai$/.test(location.hostname);
  private readonly isGemini = location.hostname === 'gemini.google.com';
  private readonly isPerplexity = /(?:^|\.)perplexity\.ai$/.test(location.hostname);
  private readonly claudeComposer = '[data-testid="chat-input"][contenteditable="true"], [data-testid="chat-input"] [contenteditable="true"], [aria-label="Send a message"][contenteditable="true"], .tiptap.ProseMirror[contenteditable="true"]';
  private readonly claudeSend = 'button[data-testid="send-button"], button[aria-label="Send message" i], button[title="Send message" i], button[aria-label="Send" i]';
  // Ordered selectors from most specific to general fallbacks
  private promptSelectors = [
    '#prompt-textarea',
    'textarea[name="prompt"]', // ChatGPT composer (2026 layout)
    '#mobile-composer-prompt',
    '[role="textbox"][contenteditable="true"]',
    'textarea[placeholder*="Ask" i]',
    'textarea[placeholder*="message" i]',
    'div.ProseMirror',
    'div[contenteditable="true"]',
    'textarea[data-id="root"]',
    '#prompt-input', // Local test bench selector
    '.ai-prompt-box', // Local test bench selector
    'textarea[placeholder*="Reply" i]',
    'textarea',
  ];

  // Selectors for ChatGPT, Claude, Gemini send buttons and test bench buttons
  private submitSelectors = [
    'button[data-testid="send-button"]',
    'button[data-testid="submit-button"]',
    'button[aria-label="Send message"]', // ChatGPT (2026 layout)
    'button[aria-label*="Send" i]',
    'button[aria-label*="send" i]',
    'button[aria-label*="Submit" i]',
    'button[title="Send" i], button[title="Send message" i], button[title="Submit" i]',
    'button.send-button',
    '#send-btn', // Local test bench selector
    'button.send-btn',
    'button[type="submit"]',
  ];

  /**
   * Determines if the current page is an approved AI domain or a test bench.
   * Excludes the management dashboard running on localhost.
   */
  public isSupportedSite(): boolean {
    const host = window.location.hostname.toLowerCase();
    const href = window.location.href.toLowerCase();

    // Actual AI chat interfaces
    const isAiChatDomain = SUPPORTED_AI_HOSTS.some((d) => host === d || host.endsWith('.' + d));

    // Dedicated extension test-bench simulator (local development backend only)
    const isTestBench =
      href.includes('test-bench') && (host === 'localhost' || host === '127.0.0.1' || location.protocol === 'chrome-extension:');

    return isAiChatDomain || isTestBench;
  }

  /**
   * Robust visibility check that works even inside position:fixed or sticky containers.
   */
  public isElementVisible(el: HTMLElement): boolean {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || el.getClientRects().length > 0;
  }

  /**
   * Scans the DOM for a visible prompt input element.
   */
  public findPromptElement(root: ParentNode = document): HTMLElement | null {
    const selectors = this.isClaude ? [this.claudeComposer, 'div.ProseMirror[contenteditable="true"][role="textbox"]', 'div.ProseMirror[contenteditable="true"]']
      : this.isGemini ? ['rich-textarea [contenteditable="true"]', '.ql-editor[contenteditable="true"]', ...this.promptSelectors]
      : this.isPerplexity ? ['#ask-input', '#search-input', ...this.promptSelectors]
      : this.promptSelectors;
    for (const selector of selectors) {
      const elements = root.querySelectorAll(selector);
      const focused = Array.from(elements).find((el) => el.contains(document.activeElement) && this.isElementVisible(el as HTMLElement));
      if (focused) return focused as HTMLElement;
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i] as HTMLElement;
        if (this.isElementVisible(el)) {
          return el;
        }
      }
    }
    return null;
  }

  /**
   * Extracts text from textarea, input, or contenteditable elements.
   */
  public getPromptText(submitter?: HTMLElement): string {
    // 1. The prompt box itself, if it has text
    const scope = this.isClaude && submitter?.closest('fieldset, form');
    const el = (scope && this.findPromptElement(scope)) || this.findPromptElement();
    const primary = el ? this.readText(el) : '';
    if (this.isClaude) return primary;
    if (primary.trim()) return primary;

    // 2. The focused editable element (sites sometimes keep a hidden mirror as the "real" box)
    const active = document.activeElement as HTMLElement | null;
    if (active && this.isEditable(active)) {
      const text = this.readText(active);
      if (text.trim()) return text;
    }

    // 3. Any prompt candidate on the page that holds text, visible or not
    for (const selector of this.promptSelectors) {
      for (const candidate of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        const text = this.readText(candidate);
        if (text.trim()) return text;
      }
    }
    return primary;
  }

  private isEditable(el: HTMLElement): boolean {
    return el instanceof HTMLTextAreaElement || el.isContentEditable || (el instanceof HTMLInputElement && el.type === 'text');
  }

  private readText(el: HTMLElement): string {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      return el.value || '';
    }
    if (el.isContentEditable || el.classList.contains('ProseMirror')) {
      return el.innerText || el.textContent || '';
    }
    return el.textContent || '';
  }

  /**
   * Sets text into the prompt box and dispatches input events so React / ProseMirror state updates.
   */
  public setPromptText(newText: string): boolean {
    const el = this.findPromptElement();
    if (!el) return false;

    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      el.value = newText;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    if (el.isContentEditable || el.classList.contains('ProseMirror')) {
      // Rich editors (ProseMirror, Lexical, Quill) keep their own document model and ignore
      // direct DOM edits, so replace the content the way a user edit would.
      el.focus();
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, newText);
      } catch {
        inserted = false;
      }
      if (!inserted) {
        el.innerText = newText;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      }
      return true;
    }

    return false;
  }

  /** Native file inputs on the page (used by AI sites for attachments). */
  public isFileInput(el: EventTarget | null): el is HTMLInputElement {
    return el instanceof HTMLInputElement && el.type === 'file';
  }

  /**
   * Checks whether a button element is a submission/send button.
   */
  public isSubmitButton(btn: HTMLElement): boolean {
    if (this.isClaude) {
      if (btn.matches(this.claudeSend)) return true;
      const prompt = this.findPromptElement();
      return btn.matches('button[type="submit"]') && Boolean(prompt && (btn.closest('fieldset')?.contains(prompt) || (btn as HTMLButtonElement).form?.contains(prompt)));
    }
    if (btn.id === 'composer-submit-button' && !btn.matches('[aria-label*="stop" i]')) return true;
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    const title = (btn.getAttribute('title') || '').toLowerCase();
    const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
    const className = (btn.className || '').toString().toLowerCase();

    if (label.includes('send') || label.includes('submit') || ['send', 'send message', 'submit'].includes(title)
        || testId.includes('send') || testId === 'submit-button' || className.includes('send')) {
      return true;
    }
    // A generic submit button counts only if it submits the form that holds the prompt box
    // (dialogs on the same page use type="submit" for Close / Dismiss).
    if (btn.matches('button[type="submit"]')) {
      const promptEl = this.findPromptElement();
      const form = btn.closest('form');
      return Boolean(form && promptEl && form.contains(promptEl));
    }
    return false;
  }

  /**
   * Finds the submission button for click event interception.
   */
  public findSubmitButton(): HTMLElement | null {
    if (this.isClaude) {
      return Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => this.isElementVisible(button) && this.isSubmitButton(button)) || null;
    }
    for (const selector of this.submitSelectors) {
      const btn = document.querySelector(selector) as HTMLElement | null;
      if (btn && this.isElementVisible(btn)) return btn;
    }
    return null;
  }
}
