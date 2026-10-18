/**
 * Device identity: an ECDSA P-256 key pair created by this browser with WebCrypto.
 *
 * The private key is generated as non-extractable and kept in IndexedDB as a CryptoKey
 * object, so no script (including this extension) can read its bytes. Copying the
 * extension folder, chrome.storage or a pasted code to another browser therefore carries
 * no usable credential: only this browser can sign the server's sign-in challenges.
 * A fresh key pair is created on every activation and deleted on sign-out or revocation.
 */

const DB_NAME = 'agentshield-identity';
const STORE = 'keys';
const KEY_ID = 'device';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

function toBase64(buf: ArrayBuffer): string {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function loadKeyPair(): Promise<CryptoKeyPair | undefined> {
  return (await withStore<CryptoKeyPair | undefined>('readonly', (s) => s.get(KEY_ID))) || undefined;
}

/** Replaces any existing identity with a new non-extractable key pair; returns the SPKI public key (base64). */
export async function createDeviceIdentity(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  await withStore('readwrite', (s) => s.put(pair, KEY_ID));
  return toBase64(await crypto.subtle.exportKey('spki', pair.publicKey));
}

/** Signs a server challenge with this browser's private key (raw r||s, base64). Null if no identity exists. */
export async function signWithDeviceKey(message: string): Promise<string | null> {
  const pair = await loadKeyPair();
  if (!pair) return null;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(message));
  return toBase64(sig);
}

export async function hasDeviceIdentity(): Promise<boolean> {
  try {
    return Boolean(await loadKeyPair());
  } catch {
    return false;
  }
}

export async function deleteDeviceIdentity(): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.delete(KEY_ID));
  } catch {
    // Nothing stored
  }
}
