import { beforeAll, describe, expect, it } from 'vitest'
import { hash } from '@node-rs/argon2'
import { decryptSecret, encryptSecret, prisma } from '@corte/db'
import { buildApp } from '../src/app.js'

const ORIGIN = 'http://localhost:5173'
const PASS = 'senha-forte-123'
let app: Awaited<ReturnType<typeof buildApp>>
let admin: Record<string, string>, user: Record<string, string>

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASS } })
  return { origin: ORIGIN, cookie: `sid=${res.cookies[0].value}`, 'x-csrf-token': res.json().csrfToken }
}

beforeAll(async () => {
  const passwordHash = await hash(PASS)
  await prisma.user.createMany({ data: [
    { email: 'adm@i.com', name: 'A', role: 'admin', passwordHash },
    { email: 'usr@i.com', name: 'U', role: 'user', passwordHash },
  ] })
  app = await buildApp()
  admin = await login('adm@i.com'); user = await login('usr@i.com')
})

describe('chaves criptografadas', () => {
  it('AES-256-GCM ida e volta, e adulteração é detectada', () => {
    const enc = encryptSecret('sk-segredo-9f2a')
    expect(enc.ciphertext).not.toContain('segredo')
    expect(enc.last4).toBe('9f2a')
    expect(decryptSecret(enc)).toBe('sk-segredo-9f2a')
    expect(() => decryptSecret({ ...enc, authTag: Buffer.alloc(16).toString('base64') })).toThrow()
  })
})

describe('integrações', () => {
  const routes = [
    { method: 'GET' as const, url: '/api/admin/integrations' },
    { method: 'PUT' as const, url: '/api/admin/integrations/pexels', payload: { enabled: true, priority: 1 } },
    { method: 'POST' as const, url: '/api/admin/integrations/pexels/test' },
  ]

  it('usuário comum recebe 403', async () => {
    for (const r of routes) expect((await app.inject({ ...r, headers: user })).statusCode, r.url).toBe(403)
  })

  it('admin salva a chave: banco guarda cifrada, API devolve só mascarada, auditoria sem o valor', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/admin/integrations/pexels', headers: admin,
      payload: { enabled: true, priority: 1, secrets: { api_key: 'chave-pexels-1234' } } })
    expect(res.statusCode).toBe(200)
    const secret = await prisma.integrationSecret.findFirst({ where: { name: 'api_key' } })
    expect(secret!.ciphertext).not.toContain('chave-pexels')
    const list = await app.inject({ url: '/api/admin/integrations', headers: admin })
    expect(list.body).not.toContain('chave-pexels')
    expect(list.json().find((i: { provider: string }) => i.provider === 'pexels').secretsSet.api_key).toBe('••••1234')
    const log = await prisma.auditLog.findFirst({ where: { action: 'integration.update' } })
    expect(log!.details).not.toContain('chave-pexels')
    expect(log!.details).toContain('api_key')
  })

  it('integração desconhecida dá 404', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/admin/integrations/nada', headers: admin, payload: { enabled: true, priority: 1 } })).statusCode).toBe(404)
  })
})

describe('vídeo', () => {
  it('outro usuário recebe 404 no vídeo', async () => {
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'adm@i.com' } })
    const p = await prisma.project.create({ data: { ownerId: owner.id, name: 'x', prompt: 'x', targetDurationS: 60 } })
    expect((await app.inject({ url: `/api/projects/${p.id}/video`, headers: user })).statusCode).toBe(404)
  })
})
