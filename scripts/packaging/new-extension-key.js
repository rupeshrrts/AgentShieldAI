/**
 * Creates the extension signing key (once) and pins the extension ID.
 *
 *   node scripts/packaging/new-extension-key.js
 *
 * - Writes keys/agentshield-extension.pem (PRIVATE, git-ignored). BACK IT UP: losing it means
 *   a new extension ID, and every PC would need the policy changed.
 * - Adds the matching public key to extension/manifest.json ("key"), so the unpacked
 *   development build, the self-hosted .crx and the policies all use the same ID.
 * - Prints the extension ID.
 * Refuses to overwrite an existing key.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const keyDir = path.join(root, 'keys');
const keyPath = path.join(keyDir, 'agentshield-extension.pem');
const manifestPath = path.join(root, 'extension', 'manifest.json');

function extensionIdFromSpki(spkiDer) {
  const hash = crypto.createHash('sha256').update(spkiDer).digest('hex').slice(0, 32);
  return hash.replace(/[0-9a-f]/g, (c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)));
}

let privateKey;
if (fs.existsSync(keyPath)) {
  console.log(`Key already exists: ${keyPath} (not overwritten)`);
  privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
} else {
  fs.mkdirSync(keyDir, { recursive: true });
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`Created ${keyPath}  <-- back this file up somewhere safe`);
}

const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.key = spki.toString('base64');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`Extension ID: ${extensionIdFromSpki(spki)}`);
module.exports = { extensionIdFromSpki };
