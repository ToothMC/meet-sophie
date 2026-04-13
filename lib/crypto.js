// lib/crypto.js — AES-256-GCM Token-Verschluesselung
// Alle OAuth-Tokens werden verschluesselt in der DB gespeichert.
// Klartext existiert nur im RAM waehrend der Verarbeitung.

import crypto from 'crypto';

const KEY = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex');

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), encrypted.toString('hex'), authTag.toString('hex')].join(':');
}

export function decrypt(ciphertext) {
  const [ivHex, encryptedHex, authTagHex] = ciphertext.split(':');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    KEY,
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final()
  ]).toString('utf8');
}
