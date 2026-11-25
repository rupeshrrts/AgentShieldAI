/**
 * Builds and packages the browser extension for distribution.
 *
 *   node scripts/packaging/pack-extension.js
 *   node scripts/packaging/pack-extension.js --portal-zip
 *
 * Output in dist-installer/package/ (served by the backend at /extension-updates/):
 *   agentshield.crx            Signed CRX3 package for self-hosted force-install (Chrome & Edge)
 *   agentshield-store.zip      Package for Chrome Web Store / Edge Add-ons upload ("key" removed)
 *   agentshield-extension.zip  Manual install: extract, then "Load unpacked" (downloadable from the dashboard)
 *   release.json               { id, version, sha256 (crx), zip_sha256, zip_size, built_at }
 *
 * Needs keys/agentshield-extension.pem (create once with new-extension-key.js).
 * Only runtime files are packaged: no sources, tests, node_modules or client-config.json.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const extDir = path.join(root, 'extension');
const outDir = path.join(root, 'dist-installer', 'package');
const keyPath = path.join(root, 'keys', 'agentshield-extension.pem');
const publicPortalUrl = 'https://agent-shield-ai-chi.vercel.app';

// Runtime files only
const INCLUDE = [
  'manifest.json',
  'managed_schema.json',
  'blocked.html',
  'blocked.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
  'dist',
  'rulesets', // website-category rules and their data licence (LICENSE-DATA.md)
  'src/popup/popup.html',
  'src/popup/popup.css',
  'src/popup/popup.js',
  'src/content/styles.css',
];

// ---------------------------------------------------------------- zip writer (deflate)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  // files: Array<{ name: string (forward slashes), data: Buffer }>
  const local = [];
  const central = [];
  let offset = 0;
  const dosTime = 0; // fixed timestamp => reproducible packages
  const dosDate = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const deflated = zlib.deflateRawSync(f.data, { level: 9 });
    const useDeflate = deflated.length < f.data.length;
    const body = useDeflate ? deflated : f.data;
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, end]);
}

// ---------------------------------------------------------------- CRX3
function varint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}
function pbBytes(field, data) {
  return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]);
}

function makeCrx3(zip, privateKey) {
  const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const crxId = crypto.createHash('sha256').update(spki).digest().subarray(0, 16);
  const signedHeaderData = pbBytes(1, crxId); // SignedData { crx_id = 1 }
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(signedHeaderData.length, 0);
  const toSign = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'binary'), lenBuf, signedHeaderData, zip]);
  const signature = crypto.sign('sha256', toSign, privateKey); // RSA PKCS#1 v1.5
  const proof = Buffer.concat([pbBytes(1, spki), pbBytes(2, signature)]); // AsymmetricKeyProof
  const header = Buffer.concat([pbBytes(2, proof), pbBytes(10000, signedHeaderData)]); // CrxFileHeader
  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'binary');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return { crx: Buffer.concat([prefix, header, zip]), spki };
}

function extensionIdFromSpki(spkiDer) {
  const hash = crypto.createHash('sha256').update(spkiDer).digest('hex').slice(0, 32);
  return hash.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

// ---------------------------------------------------------------- main
function collect(rel) {
  const abs = path.join(extDir, rel);
  if (!fs.existsSync(abs)) throw new Error(`Missing ${rel}. Did the build fail?`);
  if (fs.statSync(abs).isDirectory()) {
    return fs.readdirSync(abs).sort().flatMap((child) => collect(path.posix.join(rel, child)));
  }
  return [{ name: rel.split(path.sep).join('/'), data: fs.readFileSync(abs) }];
}

function main() {
  if (process.argv.includes('--portal-zip')) {
    const portalDir = path.join(root, 'backend', 'release', 'package');
    const releasePath = path.join(portalDir, 'release.json');
    const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
    const id = extensionIdFromSpki(Buffer.from(manifest.key, 'base64'));
    if (id !== release.id) throw new Error('Extension ID does not match the existing portal release');

    execFileSync(process.execPath, [path.join(extDir, 'build.js')], {
      cwd: extDir,
      stdio: 'inherit',
      env: { ...process.env, AGENTSHIELD_DASHBOARD_URL: process.env.AGENTSHIELD_DASHBOARD_URL?.trim() || publicPortalUrl },
    });
    const files = INCLUDE.flatMap(collect);
    const zip = makeZip(files);
    fs.writeFileSync(path.join(portalDir, 'agentshield-extension.zip'), zip);
    fs.writeFileSync(releasePath, JSON.stringify({
      ...release,
      version: manifest.version,
      crx_version: release.crx_version ?? release.version,
      zip_sha256: crypto.createHash('sha256').update(zip).digest('hex'),
      zip_size: zip.length,
      files: files.length,
      built_at: new Date().toISOString(),
    }, null, 2) + '\n');
    console.log(`Packaged portal ZIP ${manifest.version} (${files.length} files)`);
    return;
  }

  if (!fs.existsSync(keyPath)) {
    console.error(`Signing key not found: ${keyPath}\nRun: node scripts/packaging/new-extension-key.js`);
    process.exit(1);
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));

  console.log('Building extension...');
  execFileSync(process.execPath, [path.join(extDir, 'build.js')], { cwd: extDir, stdio: 'inherit' });

  const files = INCLUDE.flatMap(collect);
  const manifestEntry = files.find((f) => f.name === 'manifest.json');
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));

  const { crx, spki } = makeCrx3(makeZip(files), privateKey);
  const id = extensionIdFromSpki(spki);
  if (manifest.key && manifest.key !== spki.toString('base64')) {
    throw new Error('manifest.json "key" does not match keys/agentshield-extension.pem');
  }

  // Store upload: stores assign their own ID, so the "key" field is removed
  const storeManifest = { ...manifest };
  delete storeManifest.key;
  const storeFiles = files.map((f) =>
    f.name === 'manifest.json' ? { name: f.name, data: Buffer.from(JSON.stringify(storeManifest, null, 2)) } : f
  );

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'agentshield.crx'), crx);
  fs.writeFileSync(path.join(outDir, 'agentshield-store.zip'), makeZip(storeFiles));
  // Manual install ("Load unpacked"): keeps the "key" so the ID matches the policies
  const manualZip = makeZip(files);
  fs.writeFileSync(path.join(outDir, 'agentshield-extension.zip'), manualZip);
  const release = {
    id,
    version: manifest.version,
    sha256: crypto.createHash('sha256').update(crx).digest('hex'),
    size: crx.length,
    // Shown on the portal's download page so users can verify the downloaded zip
    zip_sha256: crypto.createHash('sha256').update(manualZip).digest('hex'),
    zip_size: manualZip.length,
    files: files.length,
    built_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'release.json'), JSON.stringify(release, null, 2) + '\n');
  console.log(`Packaged AgentShield ${release.version} (${files.length} files, ${Math.round(crx.length / 1024)} KB)`);
  console.log(`Extension ID: ${id}`);
  console.log(`Output: ${outDir}`);
}

if (require.main === module) main();
module.exports = { makeZip, makeCrx3, extensionIdFromSpki, crc32, INCLUDE, collect };
