/**
 * Checks that an activation code made the way the dashboard makes it
 * (dashboard/src/pages/MyActivation.tsx makeActivationCode) is accepted by the
 * extension (src/shared/config.ts parseActivationCode), including with stray
 * whitespace or line breaks from copy/paste, and that old enrollment codes are refused.
 */
const assert = require('assert');
const path = require('path');
const esbuild = require('esbuild');

global.chrome = { runtime: { getManifest: () => ({ version: 'test' }) } };
global.atob = global.atob || ((s) => Buffer.from(s, 'base64').toString('binary'));
global.btoa = global.btoa || ((s) => Buffer.from(s, 'binary').toString('base64'));

const out = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src/shared/config.ts')],
  bundle: true, format: 'cjs', platform: 'node', write: false,
});
const mod = { exports: {} };
new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require);
const { parseActivationCode } = mod.exports;

// Same algorithm as the dashboard
function makeActivationCode(serverUrl, token) {
  const json = JSON.stringify({ u: serverUrl.trim().replace(/\/$/, ''), t: token });
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return 'ASA1.' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const token = 'asa_' + 'A1b2-C3d4_E5f6'.repeat(3);
for (const server of ['http://localhost:8000/', 'https://agentshield.example.com']) {
  const code = makeActivationCode(server, token);
  for (const pasted of [code, `  ${code}  `, code.slice(0, 30) + '\n' + code.slice(30), `"${code}"`]) {
    const parsed = parseActivationCode(pasted);
    assert(parsed, `rejected: ${JSON.stringify(pasted)}`);
    assert.strictEqual(parsed.apiUrl, server.replace(/\/$/, ''));
    assert.strictEqual(parsed.token, token);
  }
}
assert.strictEqual(parseActivationCode(''), null);
assert.strictEqual(parseActivationCode('ASA1.garbage'), null);
// Retired organization-wide enrollment codes grant nothing
const oldCode = 'ASE1.' + Buffer.from(JSON.stringify({ u: 'http://localhost:8000', k: 'asd_x', o: 'Acme' })).toString('base64');
assert.strictEqual(parseActivationCode(oldCode), null);
// A code must carry an activation token, not some other secret
assert.strictEqual(parseActivationCode(makeActivationCode('http://localhost:8000', 'asd_not-an-activation-token')), null);
console.log('activation code round-trip: OK');
