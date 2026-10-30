/**
 * Policy decision logic (pure functions, no DOM), shared by the content script and tests.
 *
 * IMPORTANT: mirrors backend/app/policies/evaluator.py (checked by backend/tests/test_policy_twins.py):
 *   - Most restrictive action wins: BLOCK > REDACT > WARN > MONITOR > ALLOW
 *   - Severity breaks ties: CRITICAL > HIGH > MEDIUM > LOW
 *   - A rule is enforced only by an ENABLED policy that applies to the site. A disabled rule, and a
 *     rule with no policy, is not enforced. Nothing falls back to a built-in default action.
 *   - Employee governance status can only make the result stricter.
 */
import { Finding, PolicyAction, PolicyEvaluationResult, PolicyRule, SeverityLevel } from './types';

export const ACTION_PRIORITY: Record<PolicyAction, number> = {
  BLOCK: 5,
  REDACT: 4,
  WARN: 3,
  MONITOR: 2,
  ALLOW: 1,
};

export const SEVERITY_WEIGHT: Record<SeverityLevel, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

/**
 * Every rule the detectors can produce, in the same order as RULE_CATALOG in
 * backend/app/core/catalog.py. The extension only enforces once the synced policies contain all of them.
 */
export const CATALOG_RULE_IDS: string[] = [
  'secret.api_key_like',
  'pii.email',
  'pii.phone',
  'pii.credit_card',
  'pii.pan_india',
  'pii.aadhaar',
  'restricted.keyword',
  'file.upload',
  'secret.crypto_key',
  'secret.connection_string',
  'pii.iban',
  'pii.bank_account',
  'pii.upi',
  'pii.passport',
  'pii.voter_id',
  'pii.gstin',
  'restricted.internal_ip',
];

/**
 * True only when the synced policies hold a row for every catalog rule. Before the first sync (or with an
 * incomplete answer) the browser cannot know which rules are On, so it fails closed instead of guessing.
 */
export function policiesComplete(policies: PolicyRule[] | undefined | null): boolean {
  if (!Array.isArray(policies)) return false;
  const present = new Set(policies.map((p) => p.rule_id));
  return CATALOG_RULE_IDS.every((id) => present.has(id));
}

/** Host matches a policy scope: '*' or empty = all sites; otherwise exact host or subdomain. */
export function scopeMatches(scope: string | undefined, host: string): boolean {
  if (!scope || scope === '*') return true;
  const s = scope.toLowerCase().trim();
  const h = host.toLowerCase();
  return h === s || h.endsWith('.' + s);
}

/**
 * Action and severity of the enabled policy that enforces a rule on this host, or null when the rule is
 * not enforced here (no enabled policy, or the policy is scoped to other sites).
 */
export function actionForRule(
  ruleId: string,
  policies: PolicyRule[],
  host: string
): { action: PolicyAction; severity: SeverityLevel } | null {
  for (const p of policies) {
    if (p.rule_id !== ruleId || !p.enabled) continue;
    if (!scopeMatches(p.site_scope, host)) continue;
    return { action: p.action, severity: p.severity };
  }
  return null;
}

export function evaluateFindings(
  findings: Finding[],
  policies: PolicyRule[],
  host: string,
  userStatus: string = 'ACTIVE'
): PolicyEvaluationResult {
  if (userStatus === 'SUSPENDED') {
    return {
      action: 'BLOCK',
      primary_rule_id: 'enterprise.user_suspended',
      highest_severity: 'CRITICAL',
      reason:
        'Your AI tool access has been suspended by your organization\'s security team. Contact IT security to restore access.',
      findings,
      needs_confirmation: false,
    };
  }

  // Pick the most restrictive action; ties go to higher severity, then the earliest finding
  let best: { action: PolicyAction; severity: SeverityLevel; rule: string } | null = null;
  for (const f of findings) {
    const decision = actionForRule(f.rule_id, policies, host);
    if (!decision) continue;
    const { action, severity } = decision;
    if (
      !best ||
      ACTION_PRIORITY[action] > ACTION_PRIORITY[best.action] ||
      (ACTION_PRIORITY[action] === ACTION_PRIORITY[best.action] && SEVERITY_WEIGHT[severity] > SEVERITY_WEIGHT[best.severity])
    ) {
      best = { action, severity, rule: f.rule_id };
    }
  }

  let winning: PolicyAction = best ? best.action : 'ALLOW';
  const primaryRule: string | null = best ? best.rule : null;
  const highest: SeverityLevel | null = best ? best.severity : null;

  let escalated = false;
  if (userStatus === 'RESTRICTED' && winning === 'WARN') {
    winning = 'BLOCK';
    escalated = true;
  }

  const label = primaryRule ? RULE_LABELS[primaryRule] || primaryRule : '';
  let reason = 'No sensitive data detected.';
  if (winning === 'BLOCK') {
    reason = escalated
      ? `${label} detected. Your account is restricted, so warnings are treated as blocks.`
      : `${label} detected. Sending this to an AI tool is not allowed by your organization.`;
  } else if (winning === 'REDACT') {
    reason = `${label} detected. These terms must be masked before the prompt can be sent.`;
  } else if (winning === 'WARN') {
    reason = `${label} detected. Make sure sharing this is allowed before you continue.`;
  } else if (winning === 'MONITOR') {
    reason = `${label} detected. Allowed, but recorded for your security team.`;
  }

  return {
    action: winning,
    primary_rule_id: primaryRule,
    highest_severity: highest,
    reason,
    findings,
    needs_confirmation: winning === 'WARN' || winning === 'REDACT',
  };
}

/** Plain-language names shown to employees in alerts. */
export const RULE_LABELS: Record<string, string> = {
  'secret.api_key_like': 'A password, API key or access token',
  'pii.email': 'An email address',
  'pii.phone': 'A phone number',
  'pii.credit_card': 'A payment card number',
  'pii.pan_india': 'A PAN number',
  'pii.aadhaar': 'An Aadhaar number',
  'restricted.keyword': 'A confidential company term',
  'file.upload': 'A file upload',
  'secret.crypto_key': 'A crypto wallet private key',
  'secret.connection_string': 'A connection string with a password',
  'pii.iban': 'An IBAN bank account number',
  'pii.bank_account': 'Bank account details (IFSC or account number)',
  'pii.upi': 'A UPI ID',
  'pii.passport': 'A passport number',
  'pii.voter_id': 'A voter ID number',
  'pii.gstin': 'A GSTIN number',
  'restricted.internal_ip': 'An internal IP address',
};

/** What the employee should do next, shown in alerts. */
export const RULE_ADVICE: Record<string, string> = {
  'secret.api_key_like': 'Remove the credential. If it was already shared anywhere, ask IT to rotate it.',
  'pii.email': 'Remove or replace personal contact details with placeholders such as <customer email>.',
  'pii.phone': 'Remove or replace phone numbers with placeholders.',
  'pii.credit_card': 'Never paste card numbers into AI tools. Remove it before sending.',
  'pii.pan_india': 'Remove the PAN or replace it with a placeholder.',
  'pii.aadhaar': 'Never paste Aadhaar numbers into AI tools. Remove it before sending.',
  'restricted.keyword': 'Use a generic description instead of internal project names.',
  'file.upload': 'Check the file contains no customer, financial or confidential data.',
  'secret.crypto_key': 'Never share wallet keys. If it was shared anywhere, move the funds to a new wallet.',
  'secret.connection_string': 'Remove the password from the URL (use user:****@host). If it was shared, change the password.',
  'pii.iban': 'Remove the account number or replace it with a placeholder.',
  'pii.bank_account': 'Remove the IFSC code and account number before sending.',
  'pii.upi': 'Remove the UPI ID or replace it with a placeholder.',
  'pii.passport': 'Never paste passport numbers into AI tools. Remove it before sending.',
  'pii.voter_id': 'Remove the voter ID number before sending.',
  'pii.gstin': 'Check that sharing this business identifier is allowed.',
  'restricted.internal_ip': 'Replace internal addresses with placeholders such as <server-ip>.',
};
