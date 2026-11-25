/**
 * Extension unit tests (no browser needed): `npm test`
 *
 * 1. Runs backend/tests/detection_cases.json against src/content/detector.ts,
 *    the same cases pytest runs against the Python detector (keeps both in sync).
 * 2. Checks policy precedence, monitor mode, scopes and governance status (src/shared/policy.ts).
 * 3. Checks website allow/block decisions (src/shared/domains.ts).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

function load(entry) {
  const out = esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', entry)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    target: ['node18'],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const { LocalDetector } = load('src/content/detector.ts');
const { evaluateFindings } = load('src/shared/policy.ts');
const { decideHost, unapprovedAiDomains } = load('src/shared/domains.ts');
const auth = load('src/background/auth-state.ts');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n     ${e.message}`);
  }
}

// 1. Shared detection cases
const cases = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'tests', 'detection_cases.json'), 'utf8')
).cases;
const detector = new LocalDetector();
for (const c of cases) {
  test(`detect: ${c.text.slice(0, 50)}`, () => {
    const found = [...new Set(detector.detect(c.text).map((f) => f.rule_id))].sort();
    assert.deepStrictEqual(found, [...c.rules].sort());
  });
}

test('masking hides secrets, cards and Aadhaar', () => {
  const masked = detector.maskSecretsForAudit('key sk-demo-EXAMPLE123456789 card 4111 1111 1111 1111 aadhaar 4987 1234 5679');
  assert(!masked.includes('EXAMPLE123456789'));
  assert(!masked.includes('4111 1111 1111 1111'));
  assert(!masked.includes('4987 1234 5679'));
});

test('standalone password masking preserves surrounding whitespace', () => {
  assert.strictEqual(detector.maskSecretsForAudit('  SampleUser@1234\n'), '  Samp****[MASKED]\n');
});

test('redaction merges overlapping findings', () => {
  const out = detector.redact('Email demo.user@example.com about PROJECT-ALPHA-CONFIDENTIAL');
  assert(out.includes('[REDACTED:PII]') && out.includes('[REDACTED:RESTRICTED]'));
  assert(!out.includes('demo.user@example.com'));
});

// 2. Policy evaluation
const policies = [
  { id: '1', rule_id: 'secret.api_key_like', category: 'SECRET', name: '', action: 'BLOCK', severity: 'HIGH', enabled: true, version: 1 },
  { id: '2', rule_id: 'pii.email', category: 'PII', name: '', action: 'WARN', severity: 'MEDIUM', enabled: true, version: 1 },
  { id: '3', rule_id: 'pii.phone', category: 'PII', name: '', action: 'MONITOR', severity: 'LOW', enabled: true, version: 1 },
  { id: '4', rule_id: 'restricted.keyword', category: 'RESTRICTED', name: '', action: 'REDACT', severity: 'HIGH', enabled: true, version: 1 },
];
const evaluate = (text, pol = policies, host = 'chatgpt.com', status = 'ACTIVE') =>
  evaluateFindings(detector.detect(text), pol, host, status);

test('clean prompt is allowed', () => assert.strictEqual(evaluate('Explain TCP vs UDP').action, 'ALLOW'));
test('BLOCK beats REDACT and WARN', () => {
  const r = evaluate('sk-demo-EXAMPLE123456789 demo.user@example.com PROJECT-ALPHA-CONFIDENTIAL');
  assert.strictEqual(r.action, 'BLOCK');
  assert.strictEqual(r.primary_rule_id, 'secret.api_key_like');
});
test('REDACT beats WARN', () => assert.strictEqual(evaluate('demo.user@example.com PROJECT-ALPHA-CONFIDENTIAL').action, 'REDACT'));
test('WARN needs confirmation', () => {
  const r = evaluate('mail demo.user@example.com');
  assert.strictEqual(r.action, 'WARN');
  assert.strictEqual(r.needs_confirmation, true);
});
test('MONITOR allows but flags', () => {
  const r = evaluate('Call (555) 234-5678');
  assert.strictEqual(r.action, 'MONITOR');
  assert.strictEqual(r.primary_rule_id, 'pii.phone');
});
test('WARN beats MONITOR', () => assert.strictEqual(evaluate('demo.user@example.com (555) 234-5678').action, 'WARN'));
test('disabled policy is ignored', () => {
  const pol = policies.map((p) => (p.rule_id === 'secret.api_key_like' ? { ...p, enabled: false } : p));
  assert.strictEqual(evaluate('sk-demo-EXAMPLE123456789', pol).action, 'ALLOW');
});
test('rule without an enabled policy is not enforced (no built-in default)', () => {
  assert.strictEqual(evaluate('Card 4111 1111 1111 1111', []).action, 'ALLOW');
  assert.strictEqual(evaluate('sk-demo-EXAMPLE123456789', []).action, 'ALLOW');
  assert.strictEqual(evaluate('sk-demo-EXAMPLE123456789', [{ ...policies[0], enabled: false }]).action, 'ALLOW');
});
test('disabling every rule lets every detected item through', () => {
  const off = policies.map((p) => ({ ...p, enabled: false }));
  assert.strictEqual(evaluate('sk-demo-EXAMPLE123456789 demo.user@example.com PROJECT-ALPHA-CONFIDENTIAL (555) 234-5678', off).action, 'ALLOW');
});
test('site scope matches exact host and subdomains only', () => {
  const pol = [{ ...policies[1], site_scope: 'claude.ai' }];
  assert.strictEqual(evaluate('demo.user@example.com', pol, 'claude.ai').action, 'WARN');
  assert.strictEqual(evaluate('demo.user@example.com', pol, 'app.claude.ai').action, 'WARN');
  // Scoped to another site: the policy does not apply here, so nothing is enforced here
  assert.strictEqual(evaluate('demo.user@example.com', [{ ...policies[1], action: 'BLOCK', site_scope: 'claude.ai' }], 'notclaude.ai').action, 'ALLOW');
});
test('an enabled row wins over a disabled row for the same rule', () => {
  const pol = [
    { ...policies[0], enabled: false, action: 'ALLOW' },
    { ...policies[0], id: '9', enabled: true, action: 'WARN' },
  ];
  assert.strictEqual(evaluate('sk-demo-EXAMPLE123456789', pol).action, 'WARN');
});
test('SUSPENDED blocks everything', () => {
  const r = evaluate('Explain TCP', policies, 'chatgpt.com', 'SUSPENDED');
  assert.strictEqual(r.action, 'BLOCK');
  assert.strictEqual(r.primary_rule_id, 'enterprise.user_suspended');
});
test('RESTRICTED turns WARN into BLOCK', () => assert.strictEqual(evaluate('demo.user@example.com', policies, 'chatgpt.com', 'RESTRICTED').action, 'BLOCK'));

// 3. Website decisions
const lists = {
  blocked: ['pastebin.com'],
  allowed: ['chatgpt.com', 'claude.ai'],
  aiDomains: ['chatgpt.com', 'claude.ai', 'deepseek.com', 'poe.com'],
  blockUnapprovedAi: true,
};
test('explicit block includes subdomains', () => assert.strictEqual(decideHost('www.pastebin.com', lists), 'policy'));
test('lookalike domain is not blocked', () => assert.strictEqual(decideHost('notpastebin.com', lists), null));
test('approved AI site is allowed', () => assert.strictEqual(decideHost('chatgpt.com', lists), null));
test('unapproved AI site is blocked', () => assert.strictEqual(decideHost('chat.deepseek.com', lists), 'unapproved_ai'));
test('unapproved AI blocking can be turned off', () =>
  assert.strictEqual(decideHost('chat.deepseek.com', { ...lists, blockUnapprovedAi: false }), null));
test('unapproved list excludes allowed domains', () =>
  assert.deepStrictEqual(unapprovedAiDomains(lists).sort(), ['deepseek.com', 'poe.com']));
test('explicit block beats allow', () => assert.strictEqual(decideHost('pastebin.com', { ...lists, allowed: ['pastebin.com'] }), 'policy'));

// 4. Fail closed until activated
const locked = { ...lists, blockUnapprovedAi: false, locked: true };
test('locked browser blocks allowed AI sites', () => assert.strictEqual(decideHost('chatgpt.com', locked), 'activation_required'));
test('locked browser blocks built-in AI hosts with no lists', () =>
  assert.strictEqual(decideHost('gemini.google.com', { blocked: [], allowed: [], aiDomains: [], blockUnapprovedAi: false, locked: true }), 'activation_required'));
test('locked browser blocks AI subdomains', () => assert.strictEqual(decideHost('chat.deepseek.com', locked), 'activation_required'));
test('locked browser leaves other sites alone', () => assert.strictEqual(decideHost('example.com', locked), null));
test('explicit block still reported as policy when locked', () => assert.strictEqual(decideHost('pastebin.com', locked), 'policy'));
test('unlocked browser allows approved AI sites', () => assert.strictEqual(decideHost('chatgpt.com', { ...locked, locked: false }), null));

// 5. Activation and licence state machine
const { reduce, INITIAL, isAuthorized, stateForErrorCode, forgetsDevice, licenseFromServer } = auth;
const steps = (events, from = INITIAL) => events.reduce((s, e) => reduce(s, e), from);
const trial = { state: 'TRIAL_ACTIVE', plan: 'trial', expiresAt: Date.now() + 10 * 864e5, daysLeft: 10 };
const paid = { state: 'SUBSCRIPTION_ACTIVE', plan: 'annual', expiresAt: Date.now() + 300 * 864e5, daysLeft: 300 };
const granted = (license, expiresAt = Date.now() + 60_000) => [
  { type: 'CONNECT' }, { type: 'CHALLENGE_RECEIVED' }, { type: 'SESSION_GRANTED', expiresAt, license },
];
test('starts locked', () => assert.strictEqual(INITIAL.state, 'LOCKED'));
test('start without activation stays locked', () => assert.strictEqual(reduce(INITIAL, { type: 'START', activated: false }).state, 'LOCKED'));
test('start never resumes an active state', () => {
  const active = { state: 'TRIAL_ACTIVE', message: '', expiresAt: Date.now() + 60_000 };
  assert.strictEqual(reduce(active, { type: 'START', activated: true }).state, 'CONNECTING');
});
test('trial session reaches TRIAL_ACTIVE', () => {
  const s = steps(granted(trial));
  assert.strictEqual(s.state, 'TRIAL_ACTIVE');
  assert.ok(isAuthorized(s));
  assert.strictEqual(s.license.daysLeft, 10);
});
test('paid session reaches SUBSCRIPTION_ACTIVE', () => {
  const s = steps(granted(paid));
  assert.strictEqual(s.state, 'SUBSCRIPTION_ACTIVE');
  assert.ok(isAuthorized(s));
});
test('a session without an active licence verdict is not authorized', () => {
  const s = steps(granted({ state: 'EXPIRED' }));
  assert.strictEqual(s.state, 'EXPIRED');
  assert.ok(!isAuthorized(s));
});
test('a session cannot be granted without the challenge step', () => {
  const s = steps([{ type: 'SESSION_GRANTED', expiresAt: Date.now() + 60_000, license: paid }]);
  assert.strictEqual(s.state, 'LOCKED');
  assert.ok(!isAuthorized(s));
});
test('forged authorized flag without a live session is refused', () => {
  assert.ok(!isAuthorized({ state: 'SUBSCRIPTION_ACTIVE', message: '' }));
  assert.ok(!isAuthorized({ state: 'AUTHORIZED', message: '', expiresAt: Date.now() + 1e9 }));
});
test('expired session is not authorized', () => assert.ok(!isAuthorized(steps(granted(trial, Date.now() - 1)))));
test('network error locks', () => assert.strictEqual(steps([{ type: 'CONNECT' }, { type: 'NETWORK_ERROR' }]).state, 'CONNECTION_ERROR'));
test('server error codes map to failure states', () => {
  assert.strictEqual(stateForErrorCode('LICENSE_EXPIRED'), 'EXPIRED');
  assert.strictEqual(stateForErrorCode('NO_LICENSE'), 'EXPIRED');
  assert.strictEqual(stateForErrorCode('LICENSE_REVOKED'), 'REVOKED');
  assert.strictEqual(stateForErrorCode('ORG_SUSPENDED'), 'REVOKED');
  assert.strictEqual(stateForErrorCode('REVOKED'), 'REVOKED');
  assert.strictEqual(stateForErrorCode('ACCOUNT_DISABLED'), 'REVOKED');
  assert.strictEqual(stateForErrorCode('INVALID_SIGNATURE'), 'REVOKED');
  assert.strictEqual(stateForErrorCode('EXPIRED'), 'INVALID_TOKEN'); // an expired activation code
  assert.strictEqual(stateForErrorCode('PENDING_APPROVAL'), 'PENDING_APPROVAL');
  assert.strictEqual(stateForErrorCode('anything else'), 'INVALID_TOKEN');
});
test('usage limit, spend cap and used-up credits lock but keep the browser', () => {
  for (const c of ['USAGE_LIMIT', 'SPEND_CAP', 'NO_CREDITS']) {
    assert.strictEqual(stateForErrorCode(c), 'EXPIRED', c);
    assert.ok(!forgetsDevice(c), c);
    const s = steps([...granted(trial), { type: 'SERVER_REJECTED', code: c }]);
    assert.ok(!isAuthorized(s), c);
  }
});
test('prepaid credits unlock protection; credits left come from the server', () => {
  const ent = { state: 'CREDITS_ACTIVE', plan_code: 'credits', credit_balance: 42 };
  const s = steps(granted(licenseFromServer(ent)));
  assert.strictEqual(s.state, 'SUBSCRIPTION_ACTIVE');
  assert.ok(isAuthorized(s));
  assert.strictEqual(licenseFromServer(ent).credits, 42);
});
test('free plan unlocks protection; checks are not paused', () => {
  const ent = { state: 'FREE_ACTIVE', plan_code: 'free', check_limit: 300, checks_this_month: 12, resets_at: '2030-02-01T00:00:00+00:00' };
  const s = steps(granted(licenseFromServer(ent)));
  assert.strictEqual(s.state, 'FREE_ACTIVE');
  assert.ok(isAuthorized(s));
  assert.ok(!auth.checksPaused(s));
  const l = licenseFromServer(ent);
  assert.strictEqual(l.checkLimit, 300);
  assert.strictEqual(l.checksThisMonth, 12);
  assert.strictEqual(l.resetsAt, Date.parse('2030-02-01T00:00:00Z'));
});
test('free plan with checks used up stays connected but pauses checks', () => {
  const s = steps(granted({ state: 'FREE_PAUSED', plan: 'free' }));
  assert.strictEqual(s.state, 'FREE_PAUSED');
  assert.ok(isAuthorized(s));
  assert.ok(auth.checksPaused(s));
  // A paused session that expired is neither authorized nor "paused"
  const old = steps(granted({ state: 'FREE_PAUSED' }, Date.now() - 1));
  assert.ok(!isAuthorized(old) && !auth.checksPaused(old));
});
test('pause and resume on a live session follow the server verdict', () => {
  const expiresAt = Date.now() + 60_000;
  let s = steps(granted({ state: 'FREE_ACTIVE' }, expiresAt));
  s = reduce(s, { type: 'SESSION_GRANTED', expiresAt, license: { state: 'FREE_PAUSED' } });
  assert.ok(auth.checksPaused(s) && isAuthorized(s));
  s = reduce(s, { type: 'SESSION_GRANTED', expiresAt, license: { state: 'FREE_ACTIVE' } });
  assert.ok(!auth.checksPaused(s) && isAuthorized(s));
});
test('unknown licence states stay locked', () => {
  for (const st of ['FREE', 'FREE_LOCKED', 'free_active', '', 'LIMIT_REACHED']) {
    const s = steps(granted({ state: st }));
    assert.strictEqual(s.state, 'EXPIRED', st);
    assert.ok(!isAuthorized(s), st);
  }
});
test('a stored paused state cannot authorize the browser', () => {
  assert.ok(!isAuthorized({ state: 'FREE_PAUSED', message: '' }));
  assert.ok(!auth.checksPaused({ state: 'FREE_PAUSED', message: '' }));
  assert.strictEqual(reduce({ state: 'FREE_ACTIVE', message: '', expiresAt: Date.now() + 1e6 }, { type: 'START', activated: true }).state, 'CONNECTING');
});
test('licence problems keep the browser identity; device problems drop it', () => {
  for (const c of ['LICENSE_EXPIRED', 'NO_LICENSE', 'LICENSE_REVOKED', 'ORG_SUSPENDED']) assert.ok(!forgetsDevice(c), c);
  for (const c of ['REVOKED', 'ACCOUNT_DISABLED', 'DEVICE_UNKNOWN', 'INVALID_SIGNATURE']) assert.ok(forgetsDevice(c), c);
});
test('trial expiry on a live session locks', () => {
  const s = steps([...granted(trial), { type: 'SERVER_REJECTED', code: 'LICENSE_EXPIRED', license: { state: 'EXPIRED' } }]);
  assert.strictEqual(s.state, 'EXPIRED');
  assert.ok(!isAuthorized(s));
});
test('renewal after expiry returns to an active state', () => {
  const expired = steps([...granted(trial), { type: 'SERVER_REJECTED', code: 'LICENSE_EXPIRED' }]);
  assert.strictEqual(steps(granted(paid), expired).state, 'SUBSCRIPTION_ACTIVE');
});
test('licence dates come from the server', () => {
  const l = licenseFromServer({ state: 'TRIAL_ACTIVE', plan_code: 'trial', expires_at: '2030-01-01T00:00:00+00:00', days_left: 5 });
  assert.strictEqual(l.expiresAt, Date.parse('2030-01-01T00:00:00Z'));
  assert.strictEqual(l.daysLeft, 5);
  assert.strictEqual(licenseFromServer(null), undefined);
});
test('sign-out returns to LOCKED', () => assert.strictEqual(steps([{ type: 'SIGNED_OUT' }]).state, 'LOCKED'));

// 6. Website categories and Safe Search
const web = load('src/shared/web-categories.ts');
const generator = require('../scripts/update-web-categories.js');
const webConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'web-categories.json'), 'utf8'));
const sortIds = (r) => ({ enable: [...r.enable].sort(), disable: [...r.disable].sort() });

test('categories default to malware, adult and piracy on (every other category off)', () => {
  const on = ['cat_adult', 'cat_malware', 'cat_piracy'];
  assert.deepStrictEqual(sortIds(web.rulesetsFor(undefined)), {
    enable: on,
    disable: web.WEB_CATEGORY_IDS.map(web.rulesetId).filter((id) => !on.includes(id)).sort(),
  });
});
test('kids and security categories exist and are off by default', () => {
  for (const id of ['dating', 'drugs', 'hate', 'weapons', 'chat', 'mature', 'games', 'cryptomining', 'spyware', 'hacking',
    'remote_access', 'dyndns', 'shortener', 'filesharing', 'webmail', 'shopping', 'jobsearch']) {
    assert.ok(web.WEB_CATEGORY_IDS.includes(id), id);
    assert.strictEqual(web.WEB_CATEGORY_DEFAULTS[id], false, id);
  }
  assert.ok(web.rulesetsFor({ dating: true }).enable.includes('cat_dating'));
  assert.ok(web.rulesetsFor({ dating: false }).disable.includes('cat_dating'));
});
test('server switches override the defaults', () => {
  const r = sortIds(web.rulesetsFor({ adult: false, gambling: true }));
  assert.ok(r.enable.includes('cat_gambling') && !r.enable.includes('cat_adult'));
  assert.ok(r.disable.includes('cat_adult'));
});
test('malformed category settings fall back to the safe defaults', () => {
  for (const bad of [null, 'off', 42, [], { adult: 'false', malware: 0 }]) {
    assert.deepStrictEqual(sortIds(web.rulesetsFor(bad)), sortIds(web.rulesetsFor(undefined)));
  }
});
test('unknown categories are ignored', () => {
  assert.ok(!('astrology' in web.effectiveCategories({ astrology: true })));
});
test('Safe Search follows adult blocking unless set explicitly', () => {
  assert.strictEqual(web.safeSearchOn(undefined, undefined), true);
  assert.strictEqual(web.safeSearchOn(undefined, { adult: false }), false);
  assert.strictEqual(web.safeSearchOn(false, { adult: true }), false);
  assert.strictEqual(web.safeSearchOn(true, { adult: false }), true);
});
test('Safe Search rules: unique ids in their own range, loop-safe', () => {
  const rules = web.safeSearchRules();
  const ids = rules.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id >= 40001 && id < 40100));
  const google = rules.find((r) => r.action.type === 'redirect' && r.condition.regexFilter.includes('google'));
  const googleAllow = rules.find((r) => r.action.type === 'allow' && r.condition.regexFilter.includes('google'));
  assert.ok(new RegExp(google.condition.regexFilter).test('https://www.google.com/search?q=test'));
  assert.ok(new RegExp(googleAllow.condition.regexFilter).test('https://www.google.co.in/search?q=test&safe=active'));
  assert.ok(!new RegExp(googleAllow.condition.regexFilter).test('https://www.google.com/search?q=test&safe=off'));
  assert.ok(googleAllow.priority > google.priority);
  assert.ok(rules.some((r) => r.action.type === 'modifyHeaders' && r.action.requestHeaders[0].header === 'YouTube-Restrict'));
});
test('manifest declares one disabled ruleset per category', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const res = manifest.declarative_net_request.rule_resources;
  assert.deepStrictEqual(res.map((r) => r.id).sort(), web.WEB_CATEGORY_IDS.map(web.rulesetId).sort());
  assert.ok(res.every((r) => r.enabled === false && r.path === `rulesets/${r.id.slice(4)}.json`));
});
test('block page knows every category', () => {
  const blocked = fs.readFileSync(path.join(__dirname, '..', 'blocked.js'), 'utf8');
  for (const id of web.WEB_CATEGORY_IDS) assert.ok(new RegExp(`\\n\\s+${id}: \\[`).test(blocked), id);
});
test('list parser keeps valid hosts and drops protected, invalid and comment lines', () => {
  const text = '# comment\nbad-site.example\n*.Other.Example.\ngoogle.com\nmail.google.com\nnot a host\nlocalhost\nbad-site.example\n';
  const { domains, removed } = generator.parseList(text, ['google.com']);
  assert.deepStrictEqual(domains, ['bad-site.example', 'other.example']);
  assert.strictEqual(removed, 2);
});
test('rules are chunked, lowest priority and point at the block page', () => {
  const domains = Array.from({ length: 25001 }, (_, i) => `site${i}.example`);
  const rules = generator.buildRules('adult', domains);
  assert.strictEqual(rules.length, 3);
  assert.ok(rules.every((r) => r.priority === 1 && r.action.redirect.extensionPath === '/blocked.html?reason=category&category=adult'));
  assert.strictEqual(rules.reduce((n, r) => n + r.condition.requestDomains.length, 0), 25001);
});
test('generated rulesets never contain protected domains', () => {
  for (const id of web.WEB_CATEGORY_IDS) {
    const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rulesets', `${id}.json`), 'utf8'));
    assert.ok(rules.length > 0, `${id} is empty`);
    for (const r of rules) {
      assert.ok(r.action.redirect.extensionPath.endsWith(`category=${id}`));
      assert.strictEqual(r.priority, 1);
      // Chrome silently skips oversized regexes: the only regexes allowed are one-keyword address rules
      if (r.condition.regexFilter) {
        assert.ok(r.id >= generator.ADDITION_ID_BASE, `${id}: regex rule ${r.id} outside the additions range`);
        const kw = r.condition.regexFilter.replace('^https?://[^/?#]*', '');
        assert.ok(/^[a-z0-9]{3,30}$/.test(kw) && r.condition.regexFilter === generator.keywordRegex(kw), r.condition.regexFilter);
        const hit = webConfig.never_block.find((d) => generator.hostHasKeyword(d, kw));
        assert.strictEqual(hit, undefined, `${id} keyword ${kw} matches protected ${hit}`);
        continue;
      }
      if (r.condition.urlFilter) {
        assert.ok(r.id >= generator.ADDITION_ID_BASE, `${id}: name rule ${r.id} outside the additions range`);
        assert.ok(/^\|\|[a-z0-9]{5,40}$/.test(r.condition.urlFilter), r.condition.urlFilter);
        const name = r.condition.urlFilter.slice(2);
        const hit = webConfig.never_block.find((d) => generator.hostMatchesName(d, name) || generator.hostMatchesName('www.' + d, name));
        assert.strictEqual(hit, undefined, `${id} name ${name} matches protected ${hit}`);
        continue;
      }
      const bad = r.condition.requestDomains.find((d) => generator.isProtected(d, webConfig.never_block));
      assert.strictEqual(bad, undefined, `${id} contains ${bad}`);
    }
  }
});

// 7. AgentShield's own category additions
const additions = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'web-category-additions.json'), 'utf8'));
const rulesFor = (id) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rulesets', `${id}.json`), 'utf8'));
// Emulates Chrome's matching of these rules: requestDomains (with subdomains) and "||name" urlFilters
const blocksUrl = (rules, url) => {
  const host = new URL(url).hostname.toLowerCase();
  return rules.some((r) => r.condition.regexFilter
    ? new RegExp(r.condition.regexFilter, 'i').test(url)
    : r.condition.urlFilter
    ? generator.hostMatchesName(host, r.condition.urlFilter.slice(2))
    : r.condition.requestDomains.some((d) => host === d || host.endsWith('.' + d)));
};
const piracyRules = rulesFor('piracy');
const streamingRules = rulesFor('streaming');

test('additions are built into the shipped rulesets (run --additions-only after editing)', () => {
  for (const id of web.WEB_CATEGORY_IDS) {
    const rules = rulesFor(id);
    assert.deepStrictEqual(rules.filter((r) => r.id >= generator.ADDITION_ID_BASE),
      generator.buildAdditionRules(id, additions[id], webConfig.never_block), id);
    assert.ok(rules.filter((r) => r.id < generator.ADDITION_ID_BASE).every((r) => r.condition.requestDomains), id);
  }
});
test('song and movie download sites are blocked as piracy, including renamed copies', () => {
  for (const url of ['https://biharmasti.in/', 'https://biharmasti.co.in/', 'https://www.biharmasti.co.in/song/x.mp3',
    'https://pagalworld.com.se/files', 'https://www.pagalworld.pw/', 'https://filmyzilla13.org/', 'http://mrjatt1.com/',
    'https://new.djpunjab.is/?q=1', 'https://9xmovies.dad', 'https://www.movierulz.vpn:8443/', 'https://BiharMasti.IN/']) {
    assert.ok(blocksUrl(piracyRules, url), url);
  }
});
test('piracy name patterns leave ordinary sites alone', () => {
  for (const url of ['https://moviesdatabase.com/', 'https://www.imdb.com/', 'https://gaana.com/', 'https://www.jiosaavn.com/',
    'https://open.spotify.com/', 'https://music.youtube.com/', 'https://example.com/pagalworld/', 'https://example.com/?u=mrjatt.com',
    'https://www.bihar.gov.in/', 'https://chatgpt.com/', 'https://www.netflix.com/']) {
    assert.ok(!blocksUrl(piracyRules, url), url);
  }
});
test('Movies, music & streaming blocks streaming and download sites, off by default', () => {
  assert.strictEqual(web.WEB_CATEGORY_DEFAULTS.streaming, false);
  for (const url of ['https://www.netflix.com/browse', 'https://www.hotstar.com/in', 'https://www.primevideo.com/',
    'https://open.spotify.com/', 'https://gaana.com/', 'https://www.jiosaavn.com/', 'https://soundcloud.com/x',
    'https://www.y2mate.com/', 'https://mp3juices.cc/', 'https://biharmasti.co.in/']) {
    assert.ok(blocksUrl(streamingRules, url), url);
  }
  for (const url of ['https://www.youtube.com/', 'https://www.google.com/', 'https://github.com/', 'https://chatgpt.com/',
    'https://www.wikipedia.org/', 'https://mail.google.com/']) {
    assert.ok(!blocksUrl(streamingRules, url), url);
  }
});
test('address keywords block any song/movie site in Movies, music & streaming, but only in the host name', () => {
  for (const url of ['https://bhojpurimasti.in/', 'https://www.bhojpuriplanet.in/album', 'https://new-mp3-songs.xyz/',
    'https://hindimovies4u.net/', 'https://www.lyricsmint.com/', 'https://ringtonedownload.in/', 'https://pagalnew.com/',
    'https://BhojpuriMasti.IN/']) {
    assert.ok(blocksUrl(streamingRules, url), url);
  }
  for (const url of ['https://www.google.com/search?q=mp3+songs', 'https://www.bing.com/search?q=movie', 'https://github.com/mp3/x',
    'https://www.youtube.com/watch?v=song', 'https://chatgpt.com/?q=bhojpuri+song', 'https://example.com/movies/']) {
    assert.ok(!blocksUrl(streamingRules, url), url);
  }
  assert.ok(blocksUrl(piracyRules, 'https://bhojpurimasti.in/'));
  assert.ok(blocksUrl(piracyRules, 'https://www.newtorrentsite.org/'));
});
test('adult keywords block obscene addresses but not place names', () => {
  const adult = rulesFor('adult');
  for (const url of ['https://somepornsite.example/', 'https://xxx-videos.example/', 'https://desisex.example/', 'https://hentai.example/']) {
    assert.ok(blocksUrl(adult, url), url);
  }
  for (const url of ['https://www.essex.ac.uk/', 'https://www.sussex.ac.uk/', 'https://middlesex.edu/', 'https://www.google.com/search?q=porn']) {
    assert.ok(!blocksUrl(adult, url), url);
  }
});
test('Social networks leaves LinkedIn and Reddit open but blocks the others', () => {
  const social = rulesFor('social');
  for (const url of ['https://www.facebook.com/', 'https://www.instagram.com/', 'https://x.com/', 'https://www.tiktok.com/']) {
    assert.ok(blocksUrl(social, url), url);
  }
  for (const url of ['https://www.linkedin.com/feed/', 'https://in.linkedin.com/in/x', 'https://www.reddit.com/r/india',
    'https://old.reddit.com/', 'https://i.redd.it/x.png']) {
    assert.ok(!blocksUrl(social, url), url);
  }
  // Look-alike scam domains stay in Malware
  assert.ok(blocksUrl(rulesFor('malware'), 'https://linkedin.to/'));
});
test('exclusions remove a domain and its subdomains from list rules only', () => {
  const rules = [
    { id: 1, condition: { requestDomains: ['a.example', 'www.keep.example', 'keep.example'] } },
    { id: 2, condition: { requestDomains: ['only.keep.example'] } },
    { id: 1000, condition: { urlFilter: '||abcde' } },
  ];
  const out = generator.applyExclusions(rules, ['keep.example']);
  assert.deepStrictEqual(out.map((r) => r.id), [1, 1000]);
  assert.deepStrictEqual(out[0].condition.requestDomains, ['a.example']);
  assert.throws(() => generator.exclusionsFor('social', { exclude_domains: ['not a host'] }));
});
test('additions reject invalid, protected and too-short entries', () => {
  assert.throws(() => generator.buildAdditionRules('piracy', { domains: ['not a host'] }, []));
  assert.throws(() => generator.buildAdditionRules('piracy', { domains: ['drive.google.com'] }, ['google.com']));
  assert.throws(() => generator.buildAdditionRules('piracy', { domains: ['music.youtube.com'] }, ['youtube.com']));
  assert.throws(() => generator.buildAdditionRules('piracy', { name_patterns: ['mp3'] }, []));
  assert.throws(() => generator.buildAdditionRules('piracy', { name_patterns: ['bad.*regex'] }, []));
  assert.throws(() => generator.buildAdditionRules('piracy', { name_patterns: ['youtu'] }, ['youtube.com']));
  assert.throws(() => generator.buildAdditionRules('piracy', { host_keywords: ['tube'] }, ['youtube.com']));
  assert.throws(() => generator.buildAdditionRules('piracy', { host_keywords: ['a.*b'] }, []));
  assert.deepStrictEqual(generator.buildAdditionRules('piracy', undefined, []), []);
});
test('name rules are plain case-insensitive domain anchors', () => {
  for (const r of [...piracyRules, ...streamingRules].filter((x) => x.condition.urlFilter)) {
    assert.strictEqual(r.condition.isUrlFilterCaseSensitive, false);
    assert.ok(r.condition.urlFilter.startsWith('||'));
  }
});

// --- Rules must be loaded before anything is enforced (src/shared/policy.ts) ---
const policyModule = load('src/shared/policy.ts');
test('catalog matches shared detection rules and the file upload rule', () => {
  const expected = new Set(['file.upload', ...cases.flatMap((c) => c.rules)]);
  assert.deepStrictEqual([...policyModule.CATALOG_RULE_IDS].sort(), [...expected].sort());
});
test('every catalog rule has an employee label and advice', () => {
  for (const id of policyModule.CATALOG_RULE_IDS) {
    assert.ok(policyModule.RULE_LABELS[id], `label ${id}`);
    assert.ok(policyModule.RULE_ADVICE[id], `advice ${id}`);
  }
});
test('new secrets and IDs are masked before any text leaves the browser', () => {
  const masked = detector.maskSecretsForAudit(
    'db postgres://admin:S3cr3tPass@db.internal:5432/app wallet 5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ ' +
      'iban GB82 WEST 1234 5698 7654 32 my passport number is J8369854'
  );
  for (const secret of ['S3cr3tPass', 'MjxEXxiPuD5BDku4MkFq', 'WEST 1234 5698', 'J8369854']) assert.ok(!masked.includes(secret), secret);
});
test('policiesComplete needs a row for every catalog rule (fail closed until then)', () => {
  assert.strictEqual(policyModule.policiesComplete(undefined), false);
  assert.strictEqual(policyModule.policiesComplete([]), false);
  assert.strictEqual(policyModule.policiesComplete(policies), false); // only four rules synced
  const all = policyModule.CATALOG_RULE_IDS.map((rule_id) => ({ rule_id, enabled: false, action: 'ALLOW', severity: 'LOW', site_scope: '*' }));
  assert.strictEqual(policyModule.policiesComplete(all), true);
});
test('a complete set with every rule Off enforces nothing', () => {
  const all = policyModule.CATALOG_RULE_IDS.map((rule_id) => ({ id: rule_id, rule_id, category: '', name: '', action: 'BLOCK', severity: 'HIGH', enabled: false, version: 1 }));
  assert.strictEqual(evaluateFindings(detector.detect('sk-demo-EXAMPLE123456789'), all, 'chatgpt.com').action, 'ALLOW');
});

// --- Page-level category check (src/shared/category-matcher.ts): same decision as the network rules ---
const matcher = load('src/shared/category-matcher.ts');
test('page-level matcher: domains with subdomains, site-name patterns and address keywords', () => {
  const list = matcher.compileRules([
    { condition: { requestDomains: ['bad.example', 'Other.Example'] } },
    { condition: { urlFilter: '||pagalworld', isUrlFilterCaseSensitive: false } },
    { condition: { regexFilter: '^https?://[^/?#]*mp3' } },
  ]);
  assert.ok(matcher.listMatches('bad.example', list) && matcher.listMatches('www.bad.example', list));
  assert.ok(matcher.listMatches('other.example', list));
  assert.ok(!matcher.listMatches('notbad.example', list) && !matcher.listMatches('bad.example.org', list));
  assert.ok(matcher.listMatches('pagalworld.com.se', list) && matcher.listMatches('www.pagalworld.pw', list));
  assert.ok(matcher.listMatches('new-mp3-songs.xyz', list) && !matcher.listMatches('example.com', list));
});
test('page-level matcher agrees with the shipped rulesets', () => {
  const rules = (id) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rulesets', `${id}.json`), 'utf8'));
  const gambling = matcher.compileRules(rules('gambling'));
  assert.ok(matcher.listMatches(rules('gambling')[0].condition.requestDomains[0], gambling));
  const streaming = matcher.compileRules(rules('streaming'));
  assert.ok(matcher.listMatches('www.netflix.com', streaming) && matcher.listMatches('bhojpuri-songs.in', streaming));
  assert.ok(!matcher.listMatches('www.youtube.com', streaming));
  const dating = matcher.compileRules(rules('dating'));
  assert.ok(matcher.listMatches('tinder.com', dating) && matcher.listMatches('www.jeevansathi.com', dating));
});

// --- Store package checks (scripts/packaging/store-packages.js) ---
const store = require('../../scripts/packaging/store-packages.js');
const storeManifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
delete storeManifest.key;
const storeFiles = (m) => [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(m)) }];
test('store check: the shipped manifest asks only for the allowed permissions', () => {
  assert.deepStrictEqual(storeManifest.permissions.filter((p) => !store.ALLOWED_PERMISSIONS.includes(p)), []);
  assert.ok(!storeManifest.permissions.includes('nativeMessaging'));
});
test('store check: native messaging, a manifest key and an .exe are refused', () => {
  const bad = { ...storeManifest, key: 'abc', permissions: [...storeManifest.permissions, 'nativeMessaging'] };
  const problems = store.validate([...storeFiles(bad), { name: 'helper/AgentShieldHelper.exe', data: Buffer.from('MZ') }], bad, { apiUrl: '', allowLocalhost: true });
  assert.ok(problems.some((p) => p.includes('"key"')), problems.join('; '));
  assert.ok(problems.some((p) => p.includes('nativeMessaging')), problems.join('; '));
  assert.ok(problems.some((p) => p.includes('.exe')), problems.join('; '));
});
test('store check: a package without a server address is refused unless it is a test build', () => {
  assert.ok(store.validate(storeFiles(storeManifest), storeManifest, { apiUrl: '', allowLocalhost: false }).some((p) => p.includes('--api-url')));
});

// --- Browser labels for the portal (src/shared/browser-label.ts) ---
const { browserLabel } = load('src/shared/browser-label.ts');
test('browser labels for the portal', () => {
  assert.strictEqual(browserLabel({ brands: [{ brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: '130' }, { brand: 'Microsoft Edge', version: '130' }] }), 'Microsoft Edge 130');
  assert.strictEqual(browserLabel(undefined), 'Chromium');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
