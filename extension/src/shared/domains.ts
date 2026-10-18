/**
 * Website allow/block decisions, shared by the service worker (network rules and
 * tab listener) and the document_start content script, so every layer agrees.
 *
 * Order of precedence:
 *   1. Explicit BLOCK rule from the dashboard          -> blocked ("policy")
 *   2. Browser not activated (locked), AI site          -> blocked ("activation_required")
 *   3. Explicit ALLOW rule                              -> allowed
 *   4. Known AI site, when "Block unapproved AI tools"  -> blocked ("unapproved_ai")
 *   5. Everything else                                  -> allowed
 * Rules match the domain and all of its subdomains.
 */

export type BlockReason = 'policy' | 'unapproved_ai' | 'activation_required';

/** AI sites where prompts and uploads are inspected, and which are blocked until activation. */
export const SUPPORTED_AI_HOSTS = [
  'chatgpt.com',
  'openai.com',
  'claude.ai',
  'gemini.google.com',
  'aistudio.google.com',
  'copilot.microsoft.com',
  'perplexity.ai',
  'deepseek.com',
  'chat.mistral.ai',
  'poe.com',
  'meta.ai',
  'grok.com',
];

export interface DomainLists {
  blocked: string[];
  allowed: string[];
  aiDomains: string[];
  blockUnapprovedAi: boolean;
  /** True until this browser holds a live, server-issued session (fail closed). */
  locked?: boolean;
}

export function matchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase().trim();
  return d !== '' && (h === d || h.endsWith('.' + d));
}

/** Every AI host that is blocked while the browser is not activated. */
export function lockedAiHosts(lists: DomainLists): string[] {
  return Array.from(new Set([...SUPPORTED_AI_HOSTS, ...(lists.aiDomains || [])]));
}

export function decideHost(host: string, lists: DomainLists): BlockReason | null {
  if (!host) return null;
  if (lists.blocked.some((d) => matchesDomain(host, d))) return 'policy';
  if (lists.locked && lockedAiHosts(lists).some((d) => matchesDomain(host, d))) return 'activation_required';
  if (lists.allowed.some((d) => matchesDomain(host, d))) return null;
  if (lists.blockUnapprovedAi && lists.aiDomains.some((d) => matchesDomain(host, d))) return 'unapproved_ai';
  return null;
}

/** AI domains that are blocked because no ALLOW rule covers them. */
export function unapprovedAiDomains(lists: DomainLists): string[] {
  if (!lists.blockUnapprovedAi) return [];
  return lists.aiDomains.filter(
    (d) => !lists.allowed.some((a) => matchesDomain(d, a)) && !lists.blocked.some((b) => matchesDomain(d, b))
  );
}

export const RULE_FOR_REASON: Record<BlockReason, string> = {
  policy: 'dlp.blocked_domain',
  unapproved_ai: 'dlp.unapproved_ai',
  activation_required: 'access.activation_required',
};
