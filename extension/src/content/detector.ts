/**
 * Client-Side Sensitive Data Detector.
 *
 * Runs locally within the user's browser for instant pre-submission checks.
 * Uses deterministic regex patterns, checksums and restricted keyword sets without
 * incurring network latency or leaking prompt text to third parties.
 *
 * IMPORTANT: backend/app/detection/detector.py implements the same rules. Keep both
 * in sync; backend/tests/detection_cases.json is checked against both
 * (pytest, and `npm test` in extension/).
 */

import { Finding } from '../shared/types';

/** Luhn checksum used by payment card numbers. */
export function luhnValid(digits: string): boolean {
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    total += n;
  }
  return total % 10 === 0;
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff checksum used by Aadhaar numbers. */
export function verhoeffValid(digits: string): boolean {
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(digits[digits.length - 1 - i])]];
  }
  return c === 0;
}

/** Findings that are never sent or stored in readable form. */
export const ALWAYS_MASKED_RULES = new Set(['secret.api_key_like', 'pii.credit_card', 'pii.aadhaar']);

const ALNUM = /[\p{L}\p{N}]/u;

export class LocalDetector {
  // Common patterns for secrets, credentials, tokens and private keys
  private static API_KEY_PATTERNS = [
    /\bsk-demo-[A-Za-z0-9_-]{10,}\b/gi,
    /\bsk-(?:proj|live|test|ant)-[A-Za-z0-9_-]{20,}\b/g,
    /\bAKIA[0-9A-Z]{12,20}\b/g,
    /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/g,
    /\bAIza[0-9A-Za-z_-]{35}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
    /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    /\b(?:api[_-]?key|secret[_-]?token|bearer)\s*[:=]\s*['"]?([A-Za-z0-9_\-\.]{16,})['"]?/gi,
    /\b(?:password|passwd|pwd|secret)\s*[:=]\s*['"]?(\S{4,})['"]?/gi,
    /\b(?:my\s+password\s+is|password\s+is|(?:this\s+is\s+my\s+)?password\s*[:=])\s*['"]?(\S{4,})['"]?/gi,
    /\b(\S{4,})\s+(?:(?:this\s+)?is\s+my\s+(?:\w+\s+)?password)\b/gi,
  ];

  // Standard email format
  private static EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

  // Phone numbers (10+ digits, supporting formatting characters)
  private static PHONE_PATTERNS = [
    /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    /\b(?:\+91[-.\s]?)?[6-9]\d{9}\b/g,
  ];

  // Payment cards: 13-19 digits, optionally grouped, Luhn-validated
  private static CARD_PATTERN = /\b\d(?:[ -]?\d){12,18}\b/g;

  // Aadhaar: 12 digits starting 2-9, optionally grouped 4-4-4, Verhoeff-validated
  private static AADHAAR_PATTERN = /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g;

  // Indian PAN: 5 letters (4th = holder type), 4 digits, 1 letter
  private static PAN_PATTERN = /\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b/g;

  // Built-in confidential codewords, used only until the dashboard list is synced
  public static DEFAULT_KEYWORDS = [
    'PROJECT-ALPHA-CONFIDENTIAL',
    'CONFIDENTIAL_FINANCIALS',
    'INTERNAL_ONLY_DOC',
    'RESTRICTED_CUSTOMER_PII',
    'RESTRICTED_SOURCE_CODE',
  ];

  private customKeywords: Set<string>;

  constructor(customKeywords: string[] = []) {
    this.customKeywords = new Set([
      ...LocalDetector.DEFAULT_KEYWORDS,
      ...customKeywords.map((k) => k.trim()).filter(Boolean),
    ]);
  }

  /**
   * Replaces the keyword list with the one managed in the dashboard.
   * The built-in defaults are only used before the first successful sync.
   */
  public setKeywords(keywords: string[]) {
    this.customKeywords = new Set(keywords.map((k) => k.trim()).filter(Boolean));
  }

  private static matches(pattern: RegExp, text: string): RegExpExecArray[] {
    pattern.lastIndex = 0; // Reset regex state between runs
    const out: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      out.push(m);
      if (m[0].length === 0) pattern.lastIndex++;
    }
    return out;
  }

  /**
   * Scans a prompt string and returns any detected findings with start/end character offsets.
   */
  public detect(text: string): Finding[] {
    if (!text || typeof text !== 'string') return [];

    const findings: Finding[] = [];
    const add = (rule_id: string, category: Finding['category'], severity: Finding['severity'], m: RegExpExecArray) =>
      findings.push({ rule_id, category, severity, start: m.index, end: m.index + m[0].length, matched_value: m[0] });

    // 1. API keys, tokens, private keys and password definitions
    for (const pattern of LocalDetector.API_KEY_PATTERNS) {
      for (const m of LocalDetector.matches(pattern, text)) add('secret.api_key_like', 'SECRET', 'HIGH', m);
    }

    // 2. Email addresses
    for (const m of LocalDetector.matches(LocalDetector.EMAIL_PATTERN, text)) add('pii.email', 'PII', 'MEDIUM', m);

    // 3. Payment card numbers
    const numberSpans: Array<[number, number]> = [];
    for (const m of LocalDetector.matches(LocalDetector.CARD_PATTERN, text)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length >= 13 && digits.length <= 19 && new Set(digits).size > 1 && luhnValid(digits)) {
        add('pii.credit_card', 'PII', 'HIGH', m);
        numberSpans.push([m.index, m.index + m[0].length]);
      }
    }

    // 4. Aadhaar numbers
    for (const m of LocalDetector.matches(LocalDetector.AADHAAR_PATTERN, text)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length === 12 && verhoeffValid(digits)) {
        add('pii.aadhaar', 'PII', 'HIGH', m);
        numberSpans.push([m.index, m.index + m[0].length]);
      }
    }

    // 5. PAN numbers
    for (const m of LocalDetector.matches(LocalDetector.PAN_PATTERN, text)) add('pii.pan_india', 'PII', 'MEDIUM', m);

    // 6. Phone numbers: >= 10 digits, not glued to other letters/digits, not inside card/Aadhaar/secret matches
    const secretSpans: Array<[number, number]> = findings
      .filter((f) => f.category === 'SECRET')
      .map((f) => [f.start, f.end]);
    for (const pattern of LocalDetector.PHONE_PATTERNS) {
      for (const m of LocalDetector.matches(pattern, text)) {
        const start = m.index;
        const end = m.index + m[0].length;
        if (m[0].replace(/\D/g, '').length < 10) continue;
        const before = start > 0 ? text[start - 1] : '';
        const after = end < text.length ? text[end] : '';
        if ((before && (ALNUM.test(before) || before === '_' || before === '-')) || (after && ALNUM.test(after))) continue;
        if ([...numberSpans, ...secretSpans].some(([s, e]) => start < e && end > s)) continue;
        findings.push({ rule_id: 'pii.phone', category: 'PII', severity: 'LOW', start, end, matched_value: m[0].trim() });
      }
    }

    // 7. Confidential Keywords
    for (const kw of this.customKeywords) {
      if (!kw) continue;
      const kwPattern = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      for (const m of LocalDetector.matches(kwPattern, text)) add('restricted.keyword', 'RESTRICTED', 'MEDIUM', m);
    }

    // Sort findings by position (then rule ID), same order as the Python engine
    findings.sort((a, b) => a.start - b.start || (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0));
    return findings;
  }

  /**
   * Replaces detected items with redaction markers (e.g., [REDACTED:SECRET]).
   * Overlapping findings are merged; replacement runs right to left so indices stay valid.
   */
  public redact(text: string, findings?: Finding[]): string {
    const list = findings ?? this.detect(text);
    if (!list.length) return text;

    const spans: Array<[number, number, string]> = [];
    for (const f of [...list].sort((a, b) => a.start - b.start)) {
      const last = spans[spans.length - 1];
      if (last && f.start < last[1]) {
        last[1] = Math.max(last[1], f.end);
      } else {
        spans.push([f.start, f.end, f.category]);
      }
    }

    let result = text;
    for (const [start, end, category] of spans.reverse()) {
      result = result.slice(0, start) + `[REDACTED:${category}]` + result.slice(end);
    }
    return result;
  }

  /**
   * Masks credentials, card numbers and Aadhaar numbers before any text leaves the browser.
   */
  public maskSecretsForAudit(text: string, findings?: Finding[]): string {
    const list = (findings ?? this.detect(text)).filter((f) => ALWAYS_MASKED_RULES.has(f.rule_id));
    if (!list.length) return text;

    const spans: Array<[number, number]> = [];
    for (const f of [...list].sort((a, b) => a.start - b.start)) {
      const last = spans[spans.length - 1];
      if (last && f.start < last[1]) last[1] = Math.max(last[1], f.end);
      else spans.push([f.start, f.end]);
    }

    let result = text;
    for (const [start, end] of spans.reverse()) {
      const val = text.slice(start, end);
      const masked = val.length <= 8 ? '****[SECRET_MASKED]' : val.slice(0, 4) + '****[MASKED]';
      result = result.slice(0, start) + masked + result.slice(end);
    }
    return result;
  }
}
