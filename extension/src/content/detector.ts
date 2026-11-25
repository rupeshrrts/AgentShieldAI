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

import type { Finding } from '../shared/types';

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

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GSTIN check character (the GST Network's mod-36 algorithm over the first 14 characters). */
export function gstinValid(gstin: string): boolean {
  if (gstin.length !== 15) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = BASE36.indexOf(gstin[i]);
    if (v < 0) return false;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return BASE36[(36 - (sum % 36)) % 36] === gstin[14];
}

/** IBAN mod-97 check (ISO 13616); spaces are ignored. */
export function ibanValid(iban: string): boolean {
  const s = iban.replace(/ /g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  let mod = 0;
  for (const ch of s.slice(4) + s.slice(0, 4)) {
    const v = BASE36.indexOf(ch);
    if (v < 0) return false;
    for (const d of String(v)) mod = (mod * 10 + Number(d)) % 97;
  }
  return mod === 1;
}

/** Common UPI handles (the part after @). Only these count, so ordinary @mentions are not UPI IDs. */
export const UPI_HANDLES = [
  'ybl', 'ibl', 'axl', 'okaxis', 'okhdfcbank', 'okicici', 'oksbi', 'paytm', 'ptyes', 'ptaxis', 'pthdfc', 'ptsbi',
  'apl', 'yapl', 'upi', 'icici', 'sbi', 'hdfcbank', 'axisbank', 'kotak', 'idfcbank', 'idfcfirst', 'indus', 'federal',
  'pnb', 'boi', 'unionbank', 'barodampay', 'aubank', 'airtel', 'freecharge', 'jupiteraxis', 'fbl', 'waicici',
  'wahdfcbank', 'wasbi', 'waaxis', 'abfspay', 'ikwik', 'mbk', 'slice', 'naviaxis', 'yesbank', 'rbl', 'dbs', 'kbl',
  'cnrb', 'equitas', 'jio', 'superyes', 'amazonpay', 'postbank',
];

/** A password part that is only a placeholder (connection-string examples are not secrets). */
const PLACEHOLDER = /^(?:\*+|x+|<[^>]*>|\$\{[^}]*\}|\{[^}]*\}|password|pass|pwd|secret|changeme)$/i;

/** Findings that are never sent or stored in readable form. */
export const ALWAYS_MASKED_RULES = new Set([
  'secret.api_key_like', 'secret.password_like', 'pii.credit_card', 'pii.aadhaar',
  'secret.crypto_key', 'secret.connection_string', 'pii.iban', 'pii.bank_account', 'pii.passport', 'pii.voter_id',
]);

const ALNUM = /[\p{L}\p{N}]/u;

const overlaps = (spans: Array<[number, number]>, start: number, end: number) => spans.some(([s, e]) => start < e && end > s);

export class LocalDetector {
  // Common patterns for secrets, credentials, tokens and private keys
  private static API_KEY_PATTERNS = [
    /(?<![A-Za-z0-9_-])AQ\.[A-Za-z0-9_-]{40,100}(?![A-Za-z0-9_-])/g,
    /(?<![A-Za-z0-9_-])api-(?=[A-Za-z0-9]{0,79}[0-9])(?=[A-Za-z0-9]{0,79}[A-Za-z])[A-Za-z0-9]{20,80}(?![A-Za-z0-9_-])/gi,
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

  // --- 2.6 data rules. Patterns that need a nearby word put the value in group 1 at the END of the match.

  // Connection strings with a password: scheme://user:password@host (group 1 = password)
  private static CONNECTION_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s:\/@'"]+:([^\s@\/'"]{3,})@[^\s\/'"]+/g;

  // Crypto wallet private keys: Bitcoin WIF (uncompressed / compressed), BIP32 xprv, 64-hex key next to a key word
  private static CRYPTO_PATTERNS = [
    /\b5[HJK][1-9A-HJ-NP-Za-km-z]{49}\b/g,
    /\b[KL][1-9A-HJ-NP-Za-km-z]{51}\b/g,
    /\bxprv[1-9A-HJ-NP-Za-km-z]{107,108}\b/g,
    /\b(?:private[\s_-]?key|priv[\s_-]?key|wallet[\s_-]?key|seed)\b[^\n]{0,20}?\b(?:0x)?([a-fA-F0-9]{64})\b/gi,
  ];

  // IBAN: country code, 2 check digits, 11-30 letters/digits (optionally in groups), mod-97 checked
  private static IBAN_PATTERN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;

  // UPI ID: name@handle with a known UPI handle, not followed by a domain ending (that would be an email)
  private static UPI_PATTERN = new RegExp(
    `\\b[A-Za-z0-9][A-Za-z0-9._-]{1,255}@(?:${UPI_HANDLES.join('|')})(?!\\.?[A-Za-z0-9-])`,
    'gi'
  );

  // GSTIN: state code, PAN, entity number, Z, check character (checked)
  private static GSTIN_PATTERN = /\b(?:0[1-9]|[12]\d|3[0-8]|97|99)[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;

  // Indian passport number, only when the word "passport" comes shortly before it (group 1)
  private static PASSPORT_PATTERN = /\bpassport\b[^\n]{0,40}?\b([A-PR-WY][1-9]\d{6})\b/gi;

  // Voter ID (EPIC): 3 letters + 7 digits, only with "voter", "EPIC" or "election" shortly before it (group 1)
  private static VOTER_PATTERN = /\b(?:voter|epic|election)\b[^\n]{0,40}?\b([A-Z]{3}\d{7})\b/gi;

  // Indian bank details: IFSC code, or a 9-18 digit account number after "account" / "a/c" / "acct" (group 1)
  private static IFSC_PATTERN = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;
  private static ACCOUNT_PATTERN = /\b(?:a\/c|acct|account)(?:\s*(?:no|number|num)\.?)?(?:\s*is)?\s*[:#-]?\s*(\d{9,18})\b/gi;

  // Internal (private) IPv4 addresses: 10.x, 172.16-31.x, 192.168.x (not part of a longer dotted number)
  private static PRIVATE_IP_PATTERN = /\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2})\b(?!\.\d)/g;

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
    // Value in group 1 at the end of the match (the words before it are only context)
    const addGroup = (rule_id: string, category: Finding['category'], severity: Finding['severity'], m: RegExpExecArray): [number, number] => {
      const end = m.index + m[0].length;
      const start = end - m[1].length;
      findings.push({ rule_id, category, severity, start, end, matched_value: m[1] });
      return [start, end];
    };

    // 1. API keys, tokens, private keys and password definitions
    for (const pattern of LocalDetector.API_KEY_PATTERNS) {
      for (const m of LocalDetector.matches(pattern, text)) add('secret.api_key_like', 'SECRET', 'HIGH', m);
    }
    // A standalone name, symbol and digit sequence is ambiguous, so it has its own policy.
    const passwordLike = /^[ \t\r\n]*([A-Za-z]{3,32}[@!#$%&*][0-9]{4,16})(?=[ \t\r\n]*(?![\s\S]))/.exec(text);
    if (passwordLike) addGroup('secret.password_like', 'SECRET', 'MEDIUM', passwordLike);

    // 1b. Connection strings with a real password, and crypto wallet private keys
    const connectionSpans: Array<[number, number]> = [];
    for (const m of LocalDetector.matches(LocalDetector.CONNECTION_PATTERN, text)) {
      if (PLACEHOLDER.test(m[1])) continue;
      add('secret.connection_string', 'SECRET', 'HIGH', m);
      connectionSpans.push([m.index, m.index + m[0].length]);
    }
    for (const pattern of LocalDetector.CRYPTO_PATTERNS) {
      for (const m of LocalDetector.matches(pattern, text)) {
        if (m[1] !== undefined) addGroup('secret.crypto_key', 'SECRET', 'HIGH', m);
        else add('secret.crypto_key', 'SECRET', 'HIGH', m);
      }
    }

    // 2. Email addresses (not the user:password@host part of a connection string)
    for (const m of LocalDetector.matches(LocalDetector.EMAIL_PATTERN, text)) {
      if (overlaps(connectionSpans, m.index, m.index + m[0].length)) continue;
      add('pii.email', 'PII', 'MEDIUM', m);
    }

    // 2b. IBAN (checked), before cards so its digits are not read as a card or Aadhaar number
    const ibanSpans: Array<[number, number]> = [];
    for (const m of LocalDetector.matches(LocalDetector.IBAN_PATTERN, text)) {
      if (!ibanValid(m[0])) continue;
      add('pii.iban', 'PII', 'HIGH', m);
      ibanSpans.push([m.index, m.index + m[0].length]);
    }

    // 3. Payment card numbers
    const numberSpans: Array<[number, number]> = [...ibanSpans];
    for (const m of LocalDetector.matches(LocalDetector.CARD_PATTERN, text)) {
      const digits = m[0].replace(/\D/g, '');
      if (overlaps(ibanSpans, m.index, m.index + m[0].length)) continue;
      if (digits.length >= 13 && digits.length <= 19 && new Set(digits).size > 1 && luhnValid(digits)) {
        add('pii.credit_card', 'PII', 'HIGH', m);
        numberSpans.push([m.index, m.index + m[0].length]);
      }
    }

    // 4. Aadhaar numbers
    for (const m of LocalDetector.matches(LocalDetector.AADHAAR_PATTERN, text)) {
      const digits = m[0].replace(/\D/g, '');
      if (overlaps(ibanSpans, m.index, m.index + m[0].length)) continue;
      if (digits.length === 12 && verhoeffValid(digits)) {
        add('pii.aadhaar', 'PII', 'HIGH', m);
        numberSpans.push([m.index, m.index + m[0].length]);
      }
    }

    // 4b. UPI IDs, GSTIN, passport and voter ID numbers, bank details, internal IP addresses
    for (const m of LocalDetector.matches(LocalDetector.UPI_PATTERN, text)) {
      add('pii.upi', 'PII', 'MEDIUM', m);
      numberSpans.push([m.index, m.index + m[0].length]);
    }
    for (const m of LocalDetector.matches(LocalDetector.GSTIN_PATTERN, text)) {
      if (gstinValid(m[0])) add('pii.gstin', 'PII', 'LOW', m);
    }
    for (const m of LocalDetector.matches(LocalDetector.PASSPORT_PATTERN, text)) addGroup('pii.passport', 'PII', 'HIGH', m);
    for (const m of LocalDetector.matches(LocalDetector.VOTER_PATTERN, text)) addGroup('pii.voter_id', 'PII', 'MEDIUM', m);
    for (const m of LocalDetector.matches(LocalDetector.IFSC_PATTERN, text)) add('pii.bank_account', 'PII', 'HIGH', m);
    for (const m of LocalDetector.matches(LocalDetector.ACCOUNT_PATTERN, text)) {
      numberSpans.push(addGroup('pii.bank_account', 'PII', 'HIGH', m));
    }
    for (const m of LocalDetector.matches(LocalDetector.PRIVATE_IP_PATTERN, text)) {
      if (m[0].split('.').every((o) => Number(o) <= 255)) add('restricted.internal_ip', 'RESTRICTED', 'LOW', m);
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
