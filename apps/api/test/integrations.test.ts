import { beforeAll, describe, expect, it } from 'vitest'
import { hash } from '@node-rs/argon2'
import { decryptSecret, encryptSecret, prisma } from '@corte/db'
import { activeProviders } from '@corte/providers'
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

describe('integrações do usuário', () => {
  it('usuário salva a própria chave sem mexer no padrão e nunca vê a chave do admin', async () => {
    // O admin já cadastrou a do Pexels no teste anterior (padrão do sistema).
    const before = (await app.inject({ url: '/api/integrations', headers: user })).json()
    const pexels = before.find((i: { provider: string }) => i.provider === 'pexels')
    expect(pexels).toMatchObject({ configured: false, systemDefault: { enabled: true } })
    expect(pexels.secretsSet.api_key).toBeNull() // nem mascarada
    expect(JSON.stringify(before)).not.toContain('1234')

    const res = await app.inject({ method: 'PUT', url: '/api/integrations/pexels', headers: user, payload: { enabled: true, priority: 5, secrets: { api_key: 'chave-do-usuario-9999' } } })
    expect(res.statusCode).toBe(200)
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'usr@i.com' } })
    // O worker usa a chave do dono do vídeo; os outros continuam com a do admin.
    expect((await activeProviders('banco_de_imagens', owner.id))[0]).toMatchObject({ provider: 'pexels', secrets: { api_key: 'chave-do-usuario-9999' } })
    expect((await activeProviders('banco_de_imagens', null)).find((a) => a.provider === 'pexels')!.secrets.api_key).toBe('chave-pexels-1234')

    // A lista do admin continua mostrando só a chave do sistema.
    const sys = (await app.inject({ url: '/api/admin/integrations', headers: admin })).json()
    expect(sys.find((i: { provider: string }) => i.provider === 'pexels').secretsSet.api_key).toBe('••••1234')

    // Voltar ao padrão apaga a preferência (e a chave) do usuário.
    expect((await app.inject({ method: 'DELETE', url: '/api/integrations/pexels', headers: user })).statusCode).toBe(200)
    expect((await activeProviders('banco_de_imagens', owner.id)).find((a) => a.provider === 'pexels')!.secrets.api_key).toBe('chave-pexels-1234')
  })

  it('vozes e banco gratuitos já vêm conectados, sem chave', async () => {
    const voices = (await activeProviders('voz', null)).map((a) => a.provider)
    expect(voices[0]).toBe('piper') // voz neural antes da voz do macOS
    expect(voices).toContain('macos_say')
    expect((await activeProviders('banco_de_imagens', null)).map((a) => a.provider)).toContain('openverse')
  })

  it('integração paga ligada sem chave não é usada', async () => {
    await app.inject({ method: 'PUT', url: '/api/admin/integrations/openai_tts', headers: admin, payload: { enabled: true, priority: 1 } })
    expect((await activeProviders('voz', null)).map((a) => a.provider)).not.toContain('openai_tts')
  })
})

describe('logs', () => {
  it('requisições viram log e só o admin lê', async () => {
    await app.inject({ url: '/api/projects', headers: user })
    await new Promise((r) => setTimeout(r, 50)) // a gravação do log não bloqueia a resposta
    expect((await app.inject({ url: '/api/admin/logs', headers: user })).statusCode).toBe(403)
    const logs = (await app.inject({ url: '/api/admin/logs?kind=request&q=/api/projects', headers: admin })).json()
    expect(logs.rows[0]).toMatchObject({ source: 'api', kind: 'request', message: 'GET /api/projects → 200' })
    expect(JSON.stringify(logs)).not.toMatch(/cookie|sid=|csrf/i)
  })
})
