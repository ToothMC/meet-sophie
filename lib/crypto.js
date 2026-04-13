// lib/crypto.js — AES-256-GCM Token-Verschluesselung
// Alle OAuth-Tokens werden verschluesselt in der DB gespeichert.
// Klartext existiert nur im RAM waehrend der Verarbeitung.

import crypto from 'crypto';

let _key = null;
function getKey() {
  if (!_key) {
    if (!process.env.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY not set');
    const buf = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex');
    if (buf.length !== 32) throw new Error(`TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes), got ${buf.length} bytes`);
    _key = buf;
  }
  return _key;
}

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), encrypted.toString('hex'), authTag.toString('hex')].join(':');
}

export function decrypt(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string' || !ciphertext.includes(':')) {
    throw new Error('Invalid ciphertext format');
  }
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error(`Expected 3 parts in ciphertext, got ${parts.length}`);
  const [ivHex, encryptedHex, authTagHex] = parts;

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getKey(),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final()
  ]).toString('utf8');
}
