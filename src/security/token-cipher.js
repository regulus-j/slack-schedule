import { decryptJson, encryptJson } from './crypto.js'

export async function createTokenCipher(config) {
  if (config?.security?.kmsKeyName) {
    const { KeyManagementServiceClient } = await import('@google-cloud/kms')
    const client = new KeyManagementServiceClient()
    const keyName = config.security.kmsKeyName
    return {
      kind: 'gcp-kms',
      async encrypt(value) {
        const [result] = await client.encrypt({
          name: keyName,
          plaintext: Buffer.from(JSON.stringify(value), 'utf8'),
        })
        return `kms:${Buffer.from(result.ciphertext).toString('base64')}`
      },
      async decrypt(payload) {
        if (!String(payload).startsWith('kms:')) {
          if (!config.security.encryptionKey) {
            throw new Error('Legacy OAuth token requires APP_ENCRYPTION_KEY for one-time KMS migration')
          }
          return await decryptJson(payload, config.security.encryptionKey)
        }
        const ciphertext = Buffer.from(String(payload).replace(/^kms:/, ''), 'base64')
        const [result] = await client.decrypt({ name: keyName, ciphertext })
        return JSON.parse(Buffer.from(result.plaintext).toString('utf8'))
      },
      async close() {
        await client.close()
      },
    }
  }

  const secret = config?.security?.encryptionKey || ''
  return {
    kind: secret ? 'aes-256-gcm' : 'plain-json',
    async encrypt(value) {
      return secret ? await encryptJson(value, secret) : JSON.stringify(value)
    },
    async decrypt(payload) {
      if (!payload) return null
      if (secret && String(payload).includes('.')) return await decryptJson(payload, secret)
      return typeof payload === 'string' ? JSON.parse(payload) : payload
    },
    async close() {},
  }
}
