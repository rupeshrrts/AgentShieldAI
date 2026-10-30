/**
 * Builds the Chrome Web Store and Microsoft Edge Add-ons upload packages, and checks them before writing.
 *
 *   node scripts/packaging/store-packages.js --api-url https://api.example.com --dashboard-url https://portal.example.com
 *
 * Output in dist-store/ (or --out <dir>):
 *   agentshield-chrome-<version>.zip   upload in the Chrome Web Store Developer Dashboard
 *   agentshield-edge-<version>.zip     upload in Microsoft Partner Center (Edge Add-ons)
 *   store-release.json                 version, file count, size and SHA-256 of each package
 *
 * The stores sign the packages themselves, so no signing key is needed and the manifest "key" is removed.
 * --api-url / --dashboard-url are this deployment's server and portal (baked in as the defaults shown before a
 * browser is activated; activation codes carry their own server address). --allow-localhost builds a test
 * package without them. After packaging, the development build (localhost) is restored in extension/dist.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeZip, INCLUDE, collect } = require('./pack-extension');

const root = path.resolve(__dirname, '..', '..');
const extDir = path.join(root, 'extension');

// Everything the extension needs; anything else would have to be justified in the store review
const ALLOWED_PERMISSIONS = ['storage', 'alarms', 'tabs', 'declarativeNetRequest'];
const FORBIDDEN_FILE = /(^|\/)(node_modules|tests?)\/|\.(exe|dll|msi|bat|cmd|ps1|pem|key|env|map|ts|tsx|crx|zip)$|(^|\/)(client-config\.json|test-bench\.(html|js)|\.env.*)$/i;
const REMOTE_CODE = [/\beval\s*\(/, /\bnew\s+Function\s*\(/, /\bimportScripts\s*\(/, /<script[^>]+src=["']https?:/i];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function origin(value, flag) {
  if (!value) return '';
  const v = value.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/?#]+$/i.test(v)) throw new Error(`${flag} must be an https:// address without a path, got "${value}"`);
  return v;
}

function build(env) {
  execFileSync(process.execPath, [path.join(extDir, 'build.js')], {
    cwd: extDir,
    stdio: 'inherit',
    env: { ...process.env, AGENTSHIELD_API_URL: env.apiUrl || '', AGENTSHIELD_DASHBOARD_URL: env.dashboardUrl || '' },
  });
}

/** Files referenced by the manifest and by the packaged HTML pages. */
function referencedFiles(manifest, byName) {
  const refs = new Set();
  const add = (p) => p && refs.add(String(p).replace(/^\//, ''));
  add(manifest.background?.service_worker);
  for (const cs of manifest.content_scripts || []) [...(cs.js || []), ...(cs.css || [])].forEach(add);
  add(manifest.action?.default_popup);
  Object.values(manifest.icons || {}).forEach(add);
  Object.values(manifest.action?.default_icon || {}).forEach(add);
  (manifest.declarative_net_request?.rule_resources || []).forEach((r) => add(r.path));
  add(manifest.storage?.managed_schema);
  for (const war of manifest.web_accessible_resources || []) (war.resources || []).filter((r) => !r.includes('*')).forEach(add);
  for (const [name, data] of byName) {
    if (!name.endsWith('.html')) continue;
    const dir = path.posix.dirname(name);
    for (const m of data.toString('utf8').matchAll(/(?:src|href)=["']([^"'#?]+)["']/g)) {
      if (/^(https?:|data:|mailto:|#)/i.test(m[1])) continue;
      add(m[1].startsWith('/') ? m[1] : path.posix.normalize(path.posix.join(dir, m[1])));
    }
  }
  return [...refs];
}

/** Returns a list of problems; an empty list means the package can be uploaded. */
function validate(files, manifest, { apiUrl, allowLocalhost }) {
  const problems = [];
  const byName = new Map(files.map((f) => [f.name, f.data]));

  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  if ('key' in manifest) problems.push('manifest "key" must be removed for store uploads');
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || '')) problems.push(`invalid version "${manifest.version}"`);
  if (!manifest.name || manifest.name.length > 75) problems.push('name is missing or longer than 75 characters');
  if (!manifest.description || manifest.description.length > 132) problems.push('description is missing or longer than 132 characters');
  const extra = (manifest.permissions || []).filter((p) => !ALLOWED_PERMISSIONS.includes(p));
  if (extra.length) problems.push(`unexpected permissions: ${extra.join(', ')}`);
  if ((manifest.optional_permissions || []).length) problems.push('optional_permissions are not used and must not be declared');
  if (manifest.externally_connectable) problems.push('externally_connectable must not be declared');
  if (!byName.has('icons/icon-128.png')) problems.push('icons/icon-128.png (store icon) is missing');

  for (const ref of referencedFiles(manifest, byName)) {
    if (!byName.has(ref)) problems.push(`referenced file missing from package: ${ref}`);
  }
  for (const { name, data } of files) {
    if (FORBIDDEN_FILE.test(name)) problems.push(`file must not be shipped: ${name}`);
    if (name.endsWith('.json')) {
      try {
        JSON.parse(data.toString('utf8'));
      } catch {
        problems.push(`invalid JSON: ${name}`);
      }
    }
    if (/\.(js|html)$/.test(name)) {
      const text = data.toString('utf8');
      for (const re of REMOTE_CODE) if (re.test(text)) problems.push(`remote or dynamic code (${re}) in ${name}`);
    }
  }

  const sw = byName.get(String(manifest.background?.service_worker || '').replace(/^\//, ''));
  if (sw && apiUrl && !sw.toString('utf8').includes(JSON.stringify(apiUrl).slice(1, -1))) {
    problems.push(`service worker does not contain the server address ${apiUrl} (build defines not applied)`);
  }
  if (!apiUrl && !allowLocalhost) problems.push('no --api-url given (the default server would be localhost)');
  if (sw && /nativeMessaging|sendNativeMessage|connectNative/.test(sw.toString('utf8'))) {
    problems.push('service worker still uses native messaging (the Windows .exe)');
  }
  return problems;
}

function zipEntryCount(zip) {
  // End-of-central-directory record: 22 bytes at the end (no zip comment is written)
  const eocd = zip.length - 22;
  if (zip.readUInt32LE(eocd) !== 0x06054b50) throw new Error('zip end record not found');
  return zip.readUInt16LE(eocd + 10);
}

function main() {
  const allowLocalhost = process.argv.includes('--allow-localhost');
  const apiUrl = origin(arg('--api-url'), '--api-url');
  const dashboardUrl = origin(arg('--dashboard-url'), '--dashboard-url');
  const outDir = path.resolve(arg('--out') || path.join(root, 'dist-store'));
  if (!apiUrl && !allowLocalhost) {
    console.error('Give this deployment\'s server: --api-url https://your-api.example.com [--dashboard-url https://your-portal.example.com]');
    console.error('(or --allow-localhost for a test package that is not for upload)');
    process.exit(2);
  }

  console.log(`Building the store package${apiUrl ? ` for ${apiUrl}` : ' (test: localhost)'}...`);
  build({ apiUrl, dashboardUrl });
  try {
    const files = INCLUDE.flatMap(collect);
    const manifest = JSON.parse(files.find((f) => f.name === 'manifest.json').data.toString('utf8'));
    delete manifest.key;
    const storeFiles = files.map((f) =>
      f.name === 'manifest.json' ? { name: f.name, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') } : f
    );

    const problems = validate(storeFiles, manifest, { apiUrl, allowLocalhost });
    if (problems.length) {
      console.error('Store package NOT written:\n  - ' + problems.join('\n  - '));
      process.exit(1);
    }

    const zip = makeZip(storeFiles);
    if (zipEntryCount(zip) !== storeFiles.length) throw new Error('zip entry count mismatch');
    fs.mkdirSync(outDir, { recursive: true });
    const release = { version: manifest.version, api_url: apiUrl || null, dashboard_url: dashboardUrl || null, files: storeFiles.length, built_at: new Date().toISOString(), packages: {} };
    // Chrome Web Store and Edge Add-ons accept the same Manifest V3 package
    for (const store of ['chrome', 'edge']) {
      const name = `agentshield-${store}-${manifest.version}.zip`;
      fs.writeFileSync(path.join(outDir, name), zip);
      release.packages[store] = { file: name, size: zip.length, sha256: crypto.createHash('sha256').update(zip).digest('hex') };
    }
    fs.writeFileSync(path.join(outDir, 'store-release.json'), JSON.stringify(release, null, 2) + '\n');
    console.log(`Checked and written: ${storeFiles.length} files, ${Math.round(zip.length / 1024)} KB per package`);
    console.log(`Output: ${outDir}`);
  } finally {
    // Leave the development build (localhost) in extension/dist
    if (apiUrl || dashboardUrl) build({});
  }
}

if (require.main === module) main();
module.exports = { validate, referencedFiles, ALLOWED_PERMISSIONS };
