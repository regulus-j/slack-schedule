import crypto from 'node:crypto'

const ALGORITHM = 'AES-GCM'
const GCM_TAG_LENGTH_BYTES = 16

// Web Crypto API is available as globalThis.crypto in Node.js 19+.
// We import node:crypto separately for createHash (deriveKey), so the
// global `crypto` binding is shadowed — use globalThis.crypto for SubtleCrypto.
const webCrypto = globalThis.crypto

export function deriveKey(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest()
}

export async function encryptJson(value, secret) {
  if (!secret) throw new Error('APP_ENCRYPTION_KEY is required to encrypt values')
  const keyBuffer = deriveKey(secret)
  const key = await webCrypto.subtle.importKey('raw', keyBuffer, ALGORITHM, false, ['encrypt'])
  const iv = webCrypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(value))
  const encrypted = await webCrypto.subtle.encrypt({ name: ALGORITHM, iv }, key, plaintext)
  // Web Crypto API appends the 16-byte GCM authentication tag to the ciphertext.
  // Split them apart so the wire format stays backward-compatible.
  const combined = new Uint8Array(encrypted)
  const ciphertext = combined.slice(0, -GCM_TAG_LENGTH_BYTES)
  const tag = combined.slice(-GCM_TAG_LENGTH_BYTES)
  return [
    Buffer.from(iv).toString('base64'),
    Buffer.from(tag).toString('base64'),
    Buffer.from(ciphertext).toString('base64'),
  ].join('.')
}

export async function decryptJson(payload, secret) {
  if (!secret) throw new Error('APP_ENCRYPTION_KEY is required to decrypt values')
  const [ivText, tagText, encryptedText] = String(payload).split('.')
  const keyBuffer = deriveKey(secret)
  const key = await webCrypto.subtle.importKey('raw', keyBuffer, ALGORITHM, false, ['decrypt'])
  const iv = new Uint8Array(Buffer.from(ivText, 'base64'))
  const tag = new Uint8Array(Buffer.from(tagText, 'base64'))
  const ciphertext = new Uint8Array(Buffer.from(encryptedText, 'base64'))
  // AES-GCM requires the tag appended to the ciphertext for decryption.
  const combined = new Uint8Array(ciphertext.length + tag.length)
  combined.set(ciphertext)
  combined.set(tag, ciphertext.length)
  const decrypted = await webCrypto.subtle.decrypt({ name: ALGORITHM, iv }, key, combined)
  return JSON.parse(new TextDecoder().decode(decrypted))
}
