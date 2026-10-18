/**
 * Independently verifies dist-installer/package/agentshield.crx:
 *   - CRX3 magic/version, header parses
 *   - RSA-SHA256 signature over the signed data + zip is valid
 *   - the crx_id inside the signed header matches the public key and release.json
 *   - writes the embedded zip to a temp file so it can be extracted with another tool
 *
 *   node scripts/packaging/verify-crx.js [outputZipPath]
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pkgDir = path.resolve(__dirname, '..', '..', 'dist-installer', 'package');
const crx = fs.readFileSync(path.join(pkgDir, 'agentshield.crx'));
const release = JSON.parse(fs.readFileSync(path.join(pkgDir, 'release.json'), 'utf8'));

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if (b < 0x80) return [result, pos];
    shift += 7;
  }
}
function parseFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    if ((tag & 7) !== 2) throw new Error(`unexpected wire type in field ${field}`);
    let len;
    [len, pos] = readVarint(buf, pos);
    fields.push({ field, data: buf.subarray(pos, pos + len) });
    pos += len;
  }
  return fields;
}

if (crx.toString('binary', 0, 4) !== 'Cr24') throw new Error('bad magic');
if (crx.readUInt32LE(4) !== 3) throw new Error('not CRX3');
const headerLen = crx.readUInt32LE(8);
const header = crx.subarray(12, 12 + headerLen);
const zip = crx.subarray(12 + headerLen);

const top = parseFields(header);
const proofField = top.find((f) => f.field === 2);
const signedField = top.find((f) => f.field === 10000);
const proof = parseFields(proofField.data);
const spki = proof.find((f) => f.field === 1).data;
const signature = proof.find((f) => f.field === 2).data;
const crxId = parseFields(signedField.data).find((f) => f.field === 1).data;

const len = Buffer.alloc(4);
len.writeUInt32LE(signedField.data.length, 0);
const signedPayload = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'binary'), len, signedField.data, zip]);
const publicKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
if (!crypto.verify('sha256', signedPayload, publicKey, signature)) throw new Error('signature INVALID');

const expectedId = crypto.createHash('sha256').update(spki).digest().subarray(0, 16);
if (!crxId.equals(expectedId)) throw new Error('crx_id does not match public key');
const idLetters = expectedId.toString('hex').replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
if (idLetters !== release.id) throw new Error(`release.json id ${release.id} != ${idLetters}`);
if (zip.readUInt32LE(0) !== 0x04034b50) throw new Error('embedded zip missing');

const zipOut = process.argv[2] || path.join(os.tmpdir(), 'agentshield-crx-payload.zip');
fs.writeFileSync(zipOut, zip);
console.log(`CRX3 OK: signature valid, id ${idLetters}, version ${release.version}, zip ${zip.length} bytes -> ${zipOut}`);
