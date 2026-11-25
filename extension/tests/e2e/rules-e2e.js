/**
 * Real-browser end-to-end test: every dashboard switch really turns enforcement on and off.
 *
 *   cd extension; node tests/e2e/rules-e2e.js [--browser "<path to msedge.exe>"] [--skip-alarm]
 *
 * Needs Microsoft Edge (or Chromium / Chrome for Testing): branded Google Chrome 137+ no longer loads unpacked
 * extensions from the command line. Nothing touches .env's database or the internet:
 *  1. The backend runs on a throwaway SQLite file in a temp folder, with a random test admin (internal licence).
 *  2. The browser runs headless with a temporary profile, this unpacked extension (test build: node build.js --e2e)
 *     and DNS switched off for everything except 127.0.0.1, so blocked/allowed pages are judged without loading them.
 *  3. The browser is activated with a real single-use activation code, like a user does.
 *  4. Each rule is switched Off and On with the same API calls the dashboard makes; after the extension syncs, the
 *     test checks what the browser does (prompt sent, dialog shown, upload stopped, page blocked, Safe Search added).
 *  5. One change is left to the extension's own once-a-minute check (no manual sync) to measure the delay
 *     (--skip-alarm leaves this out).
 * The development build is restored at the end. Exits 1 if any check fails.
 */
const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_DIR = path.resolve(__dirname, '..', '..');
const BACKEND_DIR = path.resolve(EXT_DIR, '..', 'backend');
const API_PORT = 8010 + Math.floor(Math.random() * 50);
const DEBUG_PORT = 9330 + Math.floor(Math.random() * 50);
const API = `http://127.0.0.1:${API_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const results = [];
function check(name, actual, expected) {
  const ok = actual === expected;
  results.push({ name, ok, actual, expected });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${actual}, expected ${expected})`}`);
}

function findBrowser() {
  const given = arg('--browser');
  if (given) return given;
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/microsoft-edge',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('Microsoft Edge not found; pass --browser <path>');
  return found;
}

// ------------------------------------------------------------------ backend (throwaway database)

async function startBackend(tmp) {
  const python = path.join(BACKEND_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const admin = { email: 'e2e-admin@agentshield.local', password: 'E2e-' + crypto.randomBytes(12).toString('hex') + '!' };
  const env = {
    ...process.env,
    DATABASE_URL: 'sqlite:///' + path.join(tmp, 'e2e.db').replace(/\\/g, '/'),
    ENVIRONMENT: 'development',
    SECRET_KEY: crypto.randomBytes(32).toString('hex'),
    INITIAL_ADMIN_EMAIL: admin.email,
    INITIAL_ADMIN_PASSWORD: admin.password,
    EMAIL_VERIFICATION_REQUIRED: 'false',
    REMINDER_LOOP_ENABLED: 'false',
    PUBLIC_BASE_URL: '',
    DASHBOARD_URL: '',
    SMTP_HOST: '',
  };
  const proc = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(API_PORT)], {
    cwd: BACKEND_DIR,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  proc.stderr.on('data', (d) => (log = (log + d).slice(-4000)));
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const ok = await fetch(`${API}/health`).then((r) => r.ok).catch(() => false);
    if (ok) return { proc, admin };
    if (proc.exitCode !== null) break;
  }
  proc.kill();
  throw new Error('Backend did not start:\n' + log);
}

async function api(token, method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ------------------------------------------------------------------ browser (DevTools protocol)

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) if (l.method === msg.method && l.sessionId === msg.sessionId) l.fn(msg.params);
      }
    };
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, sessionId, fn) {
    this.listeners.push({ method, sessionId, fn });
  }
}

async function startBrowser(binary, profile) {
  const proc = spawn(
    binary,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--load-extension=${EXT_DIR}`,
      `--disable-extensions-except=${EXT_DIR}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      // No real traffic: every host except the local test backend fails DNS (network rules still apply before DNS)
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1 , EXCLUDE localhost',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    await sleep(250);
    version = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.json()).catch(() => null);
  }
  if (!version) throw new Error('Browser did not start with remote debugging');
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.open();
  let sw = null;
  for (let i = 0; i < 60 && !sw; i++) {
    await sleep(250);
    const { targetInfos } = await cdp.send('Target.getTargets');
    sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/dist/background/service-worker.js'));
  }
  if (!sw) throw new Error('The extension did not load (branded Chrome 137+ refuses --load-extension; use Edge)');
  return { proc, cdp, extId: new URL(sw.url).host, browser: version.Browser };
}

async function openTab(cdp, url, { network = false } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  const seen = [];
  if (network) {
    await cdp.send('Network.enable', {}, sessionId);
    cdp.on('Network.requestWillBeSent', sessionId, (p) => seen.push(p.request.url));
  }
  cdp.on('Page.frameNavigated', sessionId, (p) => {
    if (!p.frame.parentId) seen.push(p.frame.url);
  });
  const tab = {
    targetId,
    seen,
    async eval(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async goto(target, settleMs = 1500) {
      await cdp.send('Page.navigate', { url: target }, sessionId);
      await sleep(settleMs);
      return tab.eval('location.href').catch(() => '');
    },
    close: () => cdp.send('Target.closeTarget', { targetId }).catch(() => undefined),
  };
  if (url) await tab.goto(url);
  return tab;
}

// ------------------------------------------------------------------ checks

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentshield-e2e-'));
  let backend = null;
  let browser = null;
  try {
    console.log('Building the extension (test build)...');
    execFileSync(process.execPath, [path.join(EXT_DIR, 'build.js'), '--e2e'], { cwd: EXT_DIR, stdio: 'ignore' });

    backend = await startBackend(tmp);
    const login = await api(null, 'POST', '/auth/login', { email: backend.admin.email, password: backend.admin.password });
    const admin = login.access_token;
    browser = await startBrowser(findBrowser(), path.join(tmp, 'profile'));
    const { cdp, extId } = browser;
    console.log(`Backend ${API} · ${browser.browser} · extension ${extId}\n`);

    // Popup page in a tab: talks to the service worker like the real popup (test build only)
    const popup = await openTab(cdp, `chrome-extension://${extId}/src/popup/popup.html`);
    const message = (msg) => popup.eval(`new Promise((r) => chrome.runtime.sendMessage(${JSON.stringify(msg)}, r))`);
    const sync = async () => {
      await message({ type: 'TRIGGER_SYNC' });
      await sleep(400);
    };

    // Activation with a real single-use code
    check('locked before activation', (await message({ type: 'GET_STATUS' })).authorized, false);
    const token = await api(admin, 'POST', '/api/v1/me/activation-tokens');
    const code = 'ASA1.' + Buffer.from(JSON.stringify({ u: token.api_url, t: token.token })).toString('base64url');
    const activated = await message({ type: 'ACTIVATE', code });
    check('activation with a dashboard code', Boolean(activated && activated.ok), true);
    check('authorized after activation', (await message({ type: 'GET_STATUS' })).authorized, true);

    const policies = (await api(admin, 'GET', '/api/v1/policies')).policies;
    const byRule = Object.fromEntries(policies.map((p) => [p.rule_id, p]));
    const setRule = (ruleId, enabled, action) => api(admin, 'PATCH', `/api/v1/policies/${byRule[ruleId].id}`, { enabled, action });
    const settings = (body) => api(admin, 'PATCH', '/api/v1/org/settings', body);

    // The documented test page (README: /test-bench), checked by the installed extension like any AI site
    const BENCH = `${API}/test-bench`;
    /** What happens when the prompt is sent on the AI test page: SENT, BLOCK, WARN or REDACT. */
    const tryPrompt = async (text) => {
      const tab = await openTab(cdp, BENCH);
      await sleep(800); // content script asks the worker for the rules
      const before = await tab.eval(`document.querySelectorAll('#chat-messages .msg-user').length`);
      const readyDeadline = Date.now() + 8000;
      let out;
      let waitingForWorker;
      do {
        await tab.eval(`(() => {
          document.getElementById('agentshield-block-dismiss')?.click();
          const t = document.getElementById('prompt-input');
          t.focus(); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input', { bubbles: true }));
          document.getElementById('send-btn').click();
          return true;
        })()`);
        await sleep(700);
        out = await tab.eval(`({ sent: document.querySelectorAll('#chat-messages .msg-user').length,
          modal: (document.querySelector('.agentshield-modal-box') || { className: '' }).className,
          subtitle: document.querySelector('.agentshield-modal-subtitle')?.textContent })`);
        waitingForWorker = out.subtitle === 'Activation required' || out.subtitle === 'Protection rules loading';
      } while (waitingForWorker && Date.now() < readyDeadline);
      await tab.close();
      if (waitingForWorker) return out.subtitle;
      if (out.modal.includes('modal-block')) return 'BLOCK';
      if (out.modal.includes('modal-warn')) return 'WARN';
      if (out.modal.includes('modal-redact')) return 'REDACT';
      return out.sent > before ? 'SENT' : 'NOT SENT';
    };
    /** A text file attached on the AI test page: ALLOWED, WARN or BLOCK. */
    const tryUpload = async () => {
      const tab = await openTab(cdp, BENCH);
      await sleep(800);
      await tab.eval(`(() => {
        window.__changes = 0;
        const input = document.createElement('input');
        input.type = 'file';
        document.body.appendChild(input);
        input.addEventListener('change', () => window.__changes++);
        const dt = new DataTransfer();
        dt.items.add(new File(['meeting notes, nothing sensitive'], 'notes.txt', { type: 'text/plain' }));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sleep(700);
      const out = await tab.eval(`({ changes: window.__changes, modal: (document.querySelector('.agentshield-modal-box') || { className: '' }).className })`);
      await tab.close();
      if (out.modal.includes('modal-block')) return 'BLOCK';
      if (out.modal.includes('modal-warn')) return 'WARN';
      return out.changes > 0 ? 'ALLOWED' : 'STOPPED';
    };
    /** Visits a site; returns 'BLOCKED:<reason>' or 'NOT BLOCKED', and the URLs requested. */
    const visit = async (url) => {
      const tab = await openTab(cdp, null, { network: true });
      const final = await tab.goto(url, 1500);
      const urls = [...tab.seen, final];
      await tab.close();
      const blocked = urls.find((u) => u && u.startsWith(`chrome-extension://${extId}/blocked.html`));
      if (!blocked) return { result: 'NOT BLOCKED', urls };
      const q = new URL(blocked).searchParams;
      return { result: `BLOCKED:${q.get('reason')}${q.get('category') ? ':' + q.get('category') : ''}`, urls };
    };

    // 1. Protection rules: all Off -> nothing is enforced
    const SAMPLES = {
      'secret.api_key_like': ['my key sk-demo-EXAMPLE123456789', 'BLOCK'],
      'secret.password_like': ['SampleUser@1234', 'WARN'],
      'pii.email': ['mail demo.user@example.com today', 'WARN'],
      'pii.phone': ['call me on (555) 234-5678', 'WARN'],
      'pii.credit_card': ['card 4111 1111 1111 1111', 'BLOCK'],
      'pii.pan_india': ['my PAN is ABCPE1234F', 'WARN'],
      'pii.aadhaar': ['aadhaar 4987 1234 5679', 'BLOCK'],
      'restricted.keyword': ['plan for PROJECT-ALPHA-CONFIDENTIAL', 'REDACT'],
      'secret.crypto_key': ['Wallet key 5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ please', 'BLOCK'],
      'secret.connection_string': ['DATABASE_URL=postgres://admin:S3cr3tPass@db.internal:5432/app', 'BLOCK'],
      'pii.iban': ['Transfer to GB82 WEST 1234 5698 7654 32 today', 'BLOCK'],
      'pii.bank_account': ['IFSC HDFC0001234 for the transfer', 'WARN'],
      'pii.upi': ['Pay to rahul.sharma@okaxis for lunch', 'WARN'],
      'pii.passport': ['My passport number is J8369854', 'BLOCK'],
      'pii.voter_id': ['Voter ID: ABC1234567', 'WARN'],
      // Monitor rules record silently: the prompt is sent either way
      'pii.gstin': ['Our GSTIN is 27AAPFU0939F1ZV', 'SENT'],
      'restricted.internal_ip': ['Connect to 192.168.1.20 over SSH', 'SENT'],
    };
    for (const p of policies) await setRule(p.rule_id, false);
    await sync();
    for (const [rule, [text]] of Object.entries(SAMPLES)) check(`${rule} Off: prompt is sent`, await tryPrompt(text), 'SENT');
    check('file.upload Off: text file is attached', await tryUpload(), 'ALLOWED');

    // 2. Each rule On (default action) is enforced, and Off again stops it
    for (const [rule, [text, action]] of Object.entries(SAMPLES)) {
      await setRule(rule, true);
      await sync();
      check(`${rule} On: ${action}`, await tryPrompt(text), action);
      await setRule(rule, false);
      await sync();
      check(`${rule} Off again: prompt is sent`, await tryPrompt(text), 'SENT');
    }
    await setRule('file.upload', true);
    await sync();
    check('file.upload On: WARN before attaching', await tryUpload(), 'WARN');
    await setRule('file.upload', false);
    await sync();
    check('file.upload Off again: attached', await tryUpload(), 'ALLOWED');

    // 2b. Paste check: data an enabled BLOCK rule covers never reaches the prompt box
    const tryPaste = async (text) => {
      const tab = await openTab(cdp, BENCH);
      await sleep(800);
      const cancelled = await tab.eval(`(() => {
        const t = document.getElementById('prompt-input');
        t.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', ${JSON.stringify(text)});
        return !t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      })()`);
      await sleep(500);
      const title = await tab.eval(`(document.getElementById('agentshield-modal-title') || {}).textContent || ''`);
      await tab.close();
      if (cancelled !== (title === 'Paste blocked')) return 'Paste cancellation and dialog disagree';
      return title;
    };
    await setRule('secret.api_key_like', true);
    await sync();
    check('paste of an API key is stopped at once', await tryPaste('key sk-demo-EXAMPLE123456789'), 'Paste blocked');
    check('paste of a generic API token is stopped at once', await tryPaste('Api-a1b2c3d4e5f6g7h8i9j0k1'), 'Paste blocked');
    check('paste of an AQ. token is stopped at once', await tryPaste('AQ.Synthetic_fixture-only_0123456789abcdefghijklm'), 'Paste blocked');
    const bearerHeader = 'Authorization: Bearer sample.token~42';
    const credentialSamples = {
      UUID: 'deadbeef-abcd-4abc-abcd-abcdefabcdef',
      '32-character hex': 'abcdefabcdefabcdefabcdefabcdefab',
      'provider-prefixed secret': 'sample_live_sk_DEMO_only_abcdef_42',
      Gemini: 'AQ.Synthetic_fixture-only_0123456789abcdefghijklm',
      Claude: 'sk-ant-api03-Synthetic_fixture_0123456789-',
      OpenAI: 'sk-svcacct-Synthetic_fixture_0123456789_',
    };
    check('paste of a bearer header is blocked', await tryPaste(bearerHeader), 'Paste blocked');
    check('submission of a bearer header is blocked', await tryPrompt(bearerHeader), 'BLOCK');
    for (const [name, sample] of Object.entries(credentialSamples)) {
      check(`${name} credential paste is blocked`, await tryPaste(sample), 'Paste blocked');
    }
    check('paste of clean text is allowed', await tryPaste('explain TCP vs UDP'), '');
    await setRule('secret.api_key_like', false);
    await sync();
    check('paste with the rule Off is allowed', await tryPaste('key sk-demo-EXAMPLE123456789'), '');
    check('paste of a bearer header with the rule Off is allowed', await tryPaste(bearerHeader), '');
    check('submission of a bearer header with the rule Off is allowed', await tryPrompt(bearerHeader), 'SENT');
    for (const [name, sample] of Object.entries(credentialSamples)) {
      check(`${name} credential paste with the rule Off is allowed`, await tryPaste(sample), '');
    }
    await setRule('secret.password_like', true, 'BLOCK');
    await sync();
    check('standalone password-like paste is blocked', await tryPaste(SAMPLES['secret.password_like'][0]), 'Paste blocked');
    check('standalone password-like prompt is blocked', await tryPrompt(SAMPLES['secret.password_like'][0]), 'BLOCK');
    await setRule('secret.password_like', false, 'WARN');
    await sync();

    // 3. Website categories (lists built into the extension)
    const firstDomain = (id) => JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'rulesets', `${id}.json`), 'utf8'))[0].condition.requestDomains[0];
    const gambling = firstDomain('gambling');
    const adult = firstDomain('adult');
    await settings({ web_categories: { gambling: true } });
    await sync();
    check(`gambling On: ${gambling} blocked`, (await visit(`https://${gambling}/`)).result, 'BLOCKED:category:gambling');
    await settings({ web_categories: { gambling: false } });
    await sync();
    check(`gambling Off: ${gambling} not blocked`, (await visit(`https://${gambling}/`)).result, 'NOT BLOCKED');
    await settings({ web_categories: { adult: false } });
    await sync();
    check(`adult Off: ${adult} not blocked`, (await visit(`https://${adult}/`)).result, 'NOT BLOCKED');
    await settings({ web_categories: { adult: true } });
    await sync();
    check(`adult On: ${adult} blocked`, (await visit(`https://${adult}/`)).result, 'BLOCKED:category:adult');

    // 3b. Every other category: a site that is on this category's list only, blocked when On and open when Off
    const categoryIds = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'src', 'shared', 'web-categories.json'), 'utf8')).categories.map((c) => c.id);
    const domainsOf = (id) => new Set(JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'rulesets', `${id}.json`), 'utf8'))
      .flatMap((r) => r.condition.requestDomains || []));
    const lists = Object.fromEntries(categoryIds.map((id) => [id, domainsOf(id)]));
    const onlyIn = (id) => [...lists[id]].find((d) => categoryIds.every((other) => other === id || !lists[other].has(d)));
    const sample = {};
    for (const id of categoryIds.filter((c) => !['gambling', 'adult', 'streaming'].includes(c))) {
      const site = onlyIn(id);
      if (!site) {
        check(`${id}: a test site on this list only`, 'none found', 'found');
        continue;
      }
      sample[id] = site;
      const wasOn = (await api(admin, 'GET', '/api/v1/org/settings')).web_categories[id];
      await settings({ web_categories: { [id]: true } });
      await sync();
      check(`${id} On: ${site} blocked`, (await visit(`https://${site}/`)).result, `BLOCKED:category:${id}`);
      await settings({ web_categories: { [id]: false } });
      await sync();
      check(`${id} Off: ${site} not blocked`, (await visit(`https://${site}/`)).result, 'NOT BLOCKED');
      await settings({ web_categories: { [id]: wasOn } });
    }

    // 3d. Page level: a tab that is already open is sent to the block page when its category is switched On
    await settings({ web_categories: { dating: false } });
    await sync();
    const openPage = await openTab(cdp, null);
    await openPage.goto(`https://${sample.dating}/`, 1500);
    await settings({ web_categories: { dating: true } });
    await sync();
    await sleep(1000);
    const nowAt = (await cdp.send('Target.getTargetInfo', { targetId: openPage.targetId })).targetInfo.url;
    check('already-open tab is blocked when its category is switched On (no reload)',
      nowAt.startsWith(`chrome-extension://${extId}/blocked.html`) && nowAt.includes('category=dating'), true);
    await openPage.close();
    await settings({ web_categories: { dating: false } });
    await sync();

    // 3c. Presets from the dashboard's quick settings: Kids / family, then All off
    const presets = Object.fromEntries((await api(admin, 'GET', '/api/v1/org/settings')).web_category_presets.map((p) => [p.id, p]));
    await settings({ web_categories: presets.kids.categories, safe_search: true });
    await sync();
    for (const id of ['dating', 'chat', 'drugs', 'hate', 'weapons']) {
      check(`Kids preset: ${id} site blocked`, (await visit(`https://${sample[id]}/`)).result, `BLOCKED:category:${id}`);
    }
    check('Kids preset: shopping site still open', (await visit(`https://${sample.shopping}/`)).result, 'NOT BLOCKED');
    await settings({ web_categories: presets.off.categories, safe_search: false });
    await sync();
    for (const id of ['dating', 'malware', 'chat']) {
      check(`All off preset: ${id} site open`, (await visit(`https://${sample[id]}/`)).result, 'NOT BLOCKED');
    }
    await settings({ web_categories: Object.fromEntries(categoryIds.map((id) => [id, ['malware', 'adult', 'piracy'].includes(id)])) });
    await sync();

    // 4. Safe Search
    await settings({ safe_search: true });
    await sync();
    let bing = await visit('https://www.bing.com/search?q=test');
    check('Safe Search On: Bing gets adlt=strict', bing.urls.some((u) => /[?&]adlt=strict/.test(u || '')), true);
    await settings({ safe_search: false });
    await sync();
    bing = await visit('https://www.bing.com/search?q=test');
    check('Safe Search Off: Bing unchanged', bing.urls.some((u) => /[?&]adlt=strict/.test(u || '')), false);

    // 5. Unapproved AI tools (quillbot.com: a known AI site that is in no website category list)
    await settings({ block_unapproved_ai: true });
    await sync();
    check('Block unapproved AI On: quillbot.com blocked', (await visit('https://quillbot.com/')).result, 'BLOCKED:unapproved_ai');
    check('Block unapproved AI On: approved chatgpt.com not blocked', (await visit('https://chatgpt.com/')).result, 'NOT BLOCKED');
    await settings({ block_unapproved_ai: false });
    await sync();
    check('Block unapproved AI Off: quillbot.com not blocked', (await visit('https://quillbot.com/')).result, 'NOT BLOCKED');

    // 6. Website rules
    const rule = await api(admin, 'POST', '/api/v1/domains', { domain: 'example.org', action: 'BLOCK' });
    await sync();
    check('website rule BLOCK example.org: blocked', (await visit('https://example.org/')).result, 'BLOCKED:policy');
    await api(admin, 'PATCH', `/api/v1/domains/${rule.id}`, { enabled: false });
    await sync();
    check('website rule switched off: example.org not blocked', (await visit('https://example.org/')).result, 'NOT BLOCKED');
    await api(admin, 'DELETE', `/api/v1/domains/${rule.id}`);

    // 7. Near real time: no manual sync, the extension's own once-a-minute check picks the change up
    if (!process.argv.includes('--skip-alarm')) {
      await setRule('secret.api_key_like', true);
      const started = Date.now();
      let outcome = await tryPrompt(SAMPLES['secret.api_key_like'][0]);
      while (outcome !== 'BLOCK' && Date.now() - started < 130_000) {
        await sleep(5000);
        outcome = await tryPrompt(SAMPLES['secret.api_key_like'][0]);
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      check(`change applied without a manual sync (took ${seconds} s)`, outcome, 'BLOCK');
    }

    // Leave the default protection On
    for (const p of policies) await setRule(p.rule_id, true);
  } finally {
    if (browser) browser.proc.kill();
    if (backend) backend.proc.kill();
    // Restore the development build
    try {
      execFileSync(process.execPath, [path.join(EXT_DIR, 'build.js')], { cwd: EXT_DIR, stdio: 'ignore' });
    } catch (e) {
      console.error('Could not restore the development build: run node build.js', e.message);
    }
    await sleep(1000);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
