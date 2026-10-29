import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

function encryptionKey(keyText?: string): Buffer {
  const key = keyText ? Buffer.from(keyText, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new Error('mail_token_encryption_not_configured');
  return key;
}

export function encryptOAuthSecret(value: string, keyText?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyText), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptOAuthSecret(envelope: string, keyText?: string): string {
  const [version, ivText, tagText, ciphertextText, ...extra] = envelope.split('.');
  if (version !== VERSION || !ivText || !tagText || ciphertextText === undefined || extra.length) {
    throw new Error('mail_token_envelope_invalid');
  }
  const iv = Buffer.from(ivText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  const ciphertext = Buffer.from(ciphertextText, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('mail_token_envelope_invalid');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(keyText), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
