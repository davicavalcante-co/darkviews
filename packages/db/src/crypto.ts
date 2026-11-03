import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// AES-256-GCM com a chave mestra do .env (64 caracteres hex = 32 bytes).
function masterKey() {
  const hex = process.env.MASTER_KEY ?? ''
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('MASTER_KEY ausente ou inválida no .env (gere com: openssl rand -hex 32)')
  return Buffer.from(hex, 'hex')
}

export function encryptSecret(plain: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), last4: plain.slice(-4) }
}

export function decryptSecret(s: { ciphertext: string; iv: string; authTag: string }) {
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(s.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(s.authTag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(s.ciphertext, 'base64')), decipher.final()]).toString('utf8')
}

export const maskSecret = (last4: string) => `••••${last4}`
