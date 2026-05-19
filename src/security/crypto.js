import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

export function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest();
}

export function encryptJson(value, secret) {
  if (!secret) throw new Error('APP_ENCRYPTION_KEY is required to encrypt values');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(secret), iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64')).join('.');
}

export function decryptJson(payload, secret) {
  if (!secret) throw new Error('APP_ENCRYPTION_KEY is required to decrypt values');
  const [ivText, tagText, encryptedText] = String(payload).split('.');
  const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(secret), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}
