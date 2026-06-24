import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { encryptJson, decryptJson, deriveKey } from '../src/security/crypto.js'

const SECRET = 'test-encryption-key-32bytes!!'

test('encryptJson and decryptJson round-trip', async () => {
  const value = { access_token: 'ya29.test-token', refresh_token: '1/refresh', expiry: Date.now() }
  const encrypted = await encryptJson(value, SECRET)
  assert.ok(typeof encrypted === 'string')
  assert.ok(encrypted.length > 0)

  const decrypted = await decryptJson(encrypted, SECRET)
  assert.deepEqual(decrypted, value)
})

test('encryptJson produces different ciphertexts for same plaintext (unique IV)', async () => {
  const value = { token: 'same-token' }
  const enc1 = await encryptJson(value, SECRET)
  const enc2 = await encryptJson(value, SECRET)
  assert.notEqual(enc1, enc2)
})

test('decryptJson with wrong secret throws', async () => {
  const encrypted = await encryptJson({ data: 'secret' }, SECRET)
  await assert.rejects(
    () => decryptJson(encrypted, 'wrong-secret-32bytes!!!!'),
    /The operation failed/,
  )
})

test('decryptJson with tampered payload throws', async () => {
  const encrypted = await encryptJson({ data: 'secret' }, SECRET)
  const parts = encrypted.split('.')
  // Tamper with the ciphertext
  parts[2] = Buffer.from('tampered-data').toString('base64')
  await assert.rejects(
    () => decryptJson(parts.join('.'), SECRET),
    /The operation failed/,
  )
})

test('encryptJson throws without secret', async () => {
  await assert.rejects(
    () => encryptJson({ data: 'test' }, ''),
    /APP_ENCRYPTION_KEY is required/,
  )
})

test('decryptJson throws without secret', async () => {
  await assert.rejects(
    () => decryptJson('iv.tag.cipher', ''),
    /APP_ENCRYPTION_KEY is required/,
  )
})

test('backward compatibility: old sync-encrypted tokens can be decrypted by async decryptJson', async () => {
  // Simulate encryption using the OLD synchronous path with the SAME format
  function legacyEncrypt(value, secret) {
    const key = crypto.createHash('sha256').update(String(secret || '')).digest()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    return [iv, tag, encrypted].map((part) => part.toString('base64')).join('.')
  }

  const value = { access_token: 'legacy-token', nested: { deep: true } }
  const legacyEncrypted = legacyEncrypt(value, SECRET)

  // The new async decryptJson should handle it
  const decrypted = await decryptJson(legacyEncrypted, SECRET)
  assert.deepEqual(decrypted, value)
})

test('forward compatibility: async-encrypted tokens use same wire format', async () => {
  const value = { test: 'forward-compat' }
  const encrypted = await encryptJson(value, SECRET)

  // Verify wire format: three base64 segments separated by dots
  const parts = encrypted.split('.')
  assert.equal(parts.length, 3)

  // Each part should be valid base64
  for (const part of parts) {
    const decoded = Buffer.from(part, 'base64')
    assert.ok(decoded.length > 0)
  }

  // IV should be 12 bytes
  assert.equal(Buffer.from(parts[0], 'base64').length, 12)

  // Tag should be 16 bytes (GCM auth tag)
  assert.equal(Buffer.from(parts[1], 'base64').length, 16)
})

test('deriveKey produces consistent 32-byte keys', () => {
  const key1 = deriveKey(SECRET)
  const key2 = deriveKey(SECRET)
  assert.equal(key1.length, 32) // SHA-256 = 32 bytes
  assert.deepEqual(key1, key2)
})

test('deriveKey handles empty secret', () => {
  const key = deriveKey('')
  assert.equal(key.length, 32)
})

test('encrypts and decrypts complex nested objects', async () => {
  const value = {
    string: 'hello',
    number: 42,
    boolean: true,
    null: null,
    array: [1, 'two', { three: 3 }],
    nested: { a: { b: { c: 'deep' } } },
    unicode: 'emoji 🎉 and japanese 日本語',
  }
  const encrypted = await encryptJson(value, SECRET)
  const decrypted = await decryptJson(encrypted, SECRET)
  assert.deepEqual(decrypted, value)
})
