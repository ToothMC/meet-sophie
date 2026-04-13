// lib/crypto.js — AES-256-GCM Token-Verschluesselung
// Alle OAuth-Tokens werden verschluesselt in der DB gespeichert.
// Klartext existiert nur im RAM waehrend der Verarbeitung.

import crypto from 'crypto';

let _key = null;
function getKey() {
  if (!_key) {
    if (!process.env.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY not set');
    _key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex');
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
  const [ivHex, encryptedHex, authTagHex] = ciphertext.split(':');
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
