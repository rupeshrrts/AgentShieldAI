/**
 * Policy decision logic (pure functions, no DOM), shared by the content script and tests.
 *
 * IMPORTANT: mirrors backend/app/policies/evaluator.py:
 *   - Most restrictive action wins: BLOCK > REDACT > WARN > MONITOR > ALLOW
 *   - Severity breaks ties: CRITICAL > HIGH > MEDIUM > LOW
 *   - Rules without a configured policy use the category default
 *   - Disabled policies and policies scoped to other sites are ignored
 * Employee governance status can only make the result stricter.
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

export const CATEGORY_DEFAULT_ACTION: Record<string, PolicyAction> = {
  SECRET: 'BLOCK',
  PII: 'WARN',
  RESTRICTED: 'REDACT',
  FILE: 'WARN',
};

/** Host matches a policy scope: '*' or empty = all sites; otherwise exact host or subdomain. */
export function scopeMatches(scope: string | undefined, host: string): boolean {
  if (!scope || scope === '*') return true;
  const s = scope.toLowerCase().trim();
  const h = host.toLowerCase();
  return h === s || h.endsWith('.' + s);
}

/** Effective action/severity for one rule ID on this host, or null if the rule is disabled. */
export function actionForRule(
  ruleId: string,
  category: string,
  defaultSeverity: SeverityLevel,
  policies: PolicyRule[],
  host: string
): { action: PolicyAction; severity: SeverityLevel } | null {
  let disabled = false;
  for (const p of policies) {
    if (p.rule_id !== ruleId) continue;
    if (!p.enabled) {
      disabled = true;
      continue;
    }
    if (!scopeMatches(p.site_scope, host)) continue;
    return { action: p.action, severity: p.severity };
  }
  if (disabled) return null;
  return { action: CATEGORY_DEFAULT_ACTION[category] || 'WARN', severity: defaultSeverity };
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
    const decision = actionForRule(f.rule_id, f.category, f.severity, policies, host);
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
};
