import { beforeAll, describe, expect, it } from 'vitest'
import { hash } from '@node-rs/argon2'
import { prisma } from '@corte/db'
import { buildApp } from '../src/app.js'

const ORIGIN = 'http://localhost:5173'
const PASS = 'senha-forte-123'
let app: Awaited<ReturnType<typeof buildApp>>
let admin: Record<string, string>, user: Record<string, string>
let userId = ''

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASS } })
  return { origin: ORIGIN, cookie: `sid=${res.cookies[0].value}`, 'x-csrf-token': res.json().csrfToken }
}
async function create(headers: Record<string, string>, fields: Record<string, string> = {}) {
  const form = new FormData()
  for (const [k, v] of Object.entries({ name: 'V', prompt: 'p', targetDurationS: '60', fontFamily: 'Inter', highlightMode: 'manual', ...fields })) form.append(k, v)
  const req = new Request('http://x', { method: 'POST', body: form })
  return app.inject({ method: 'POST', url: '/api/projects', headers: { ...headers, 'content-type': req.headers.get('content-type')! }, payload: Buffer.from(await req.arrayBuffer()) })
}

beforeAll(async () => {
  const passwordHash = await hash(PASS)
  await prisma.user.create({ data: { email: 'chefe@a.com', name: 'Chefe', role: 'admin', passwordHash } })
  userId = (await prisma.user.create({ data: { email: 'comum@a.com', name: 'Comum', role: 'user', passwordHash } })).id
  app = await buildApp()
  admin = await login('chefe@a.com'); user = await login('comum@a.com')
})

// Todas as rotas de admin. Rota nova de admin entra aqui.
const ADMIN_ROUTES = [
  ['GET', '/api/admin/settings'], ['PUT', '/api/admin/settings'],
  ['GET', '/api/admin/fonts'], ['POST', '/api/admin/fonts'], ['PUT', '/api/admin/fonts/Inter'],
  ['GET', '/api/admin/audit'],
  ['GET', '/api/admin/logs'],
  ['GET', '/api/admin/claude/mcp'], ['POST', '/api/admin/claude/mcp/connect'], ['POST', '/api/admin/claude/mcp/disconnect'],
  ['GET', '/api/admin/claude'], ['POST', '/api/admin/claude/connect'], ['POST', '/api/admin/claude/code'], ['POST', '/api/admin/claude/cancel'],
].map(([method, url]) => ({ method, url }))

describe('todas as rotas de admin', () => {
  it('usuário comum recebe 403 e quem não está logado recebe 401', async () => {
    for (const r of ADMIN_ROUTES) {
      const opts = { method: r.method as 'GET', url: r.url, payload: r.method === 'GET' ? undefined : {} }
      expect((await app.inject({ ...opts, headers: user })).statusCode, `${r.method} ${r.url}`).toBe(403)
      expect((await app.inject({ ...opts, headers: { origin: ORIGIN } })).statusCode, `${r.method} ${r.url}`).toBe(401)
    }
  })
})

describe('plano e limites', () => {
  it('admin salva, fica no audit_logs e o limite diário vale para criar vídeo', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: admin, payload: { plan_name: 'Max', plan_renews_at: '2026-12-01', max_duration_s: 600, daily_video_limit: 1 } })
    expect(res.statusCode).toBe(200)
    expect(await prisma.auditLog.count({ where: { action: 'settings.update' } })).toBe(1)
    expect((await create(user, { targetDurationS: '601' })).statusCode).toBe(400) // acima do máximo do admin
    expect((await create(user)).statusCode).toBe(201)
    expect((await create(user)).statusCode).toBe(429) // segundo do dia
    await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: admin, payload: { plan_name: 'Max', plan_renews_at: '2026-12-01', max_duration_s: 1080, daily_video_limit: 0 } })
  })
  it('não aceita duração máxima acima de 18 minutos', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: admin, payload: { max_duration_s: 1081, daily_video_limit: 0 } })).statusCode).toBe(400)
  })
})

describe('conectar ao Claude', () => {
  it('código precisa vir depois de iniciar o login e não aceita espaços', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/admin/claude/code', headers: admin, payload: { code: 'tem espaço no meio' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/admin/claude/code', headers: admin, payload: { code: 'codigo-valido-123' } })).statusCode).toBe(409)
  })
})

describe('fontes', () => {
  it('fonte bloqueada some para o usuário; não dá para bloquear todas', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/admin/fonts/Inter', headers: admin, payload: { enabled: false } })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/fonts', headers: user })).json()).not.toContain('Inter')
    // Bloqueia todas as liberadas menos uma (outros testes podem ter enviado fontes ao mesmo banco).
    const on = ((await app.inject({ url: '/api/fonts', headers: admin })).json() as string[])
    for (const f of on.slice(0, -1)) await app.inject({ method: 'PUT', url: `/api/admin/fonts/${encodeURIComponent(f)}`, headers: admin, payload: { enabled: false } })
    expect((await app.inject({ method: 'PUT', url: `/api/admin/fonts/${encodeURIComponent(on.at(-1)!)}`, headers: admin, payload: { enabled: false } })).statusCode).toBe(409)
    for (const f of [...on, 'Inter']) await app.inject({ method: 'PUT', url: `/api/admin/fonts/${encodeURIComponent(f)}`, headers: admin, payload: { enabled: true } })
  })
})

describe('painel', () => {
  it('usuário vê só os próprios números e nada de tokens; admin vê tudo', async () => {
    const outro = await prisma.user.findFirstOrThrow({ where: { email: 'chefe@a.com' } })
    await prisma.project.create({ data: { ownerId: outro.id, name: 'do admin', prompt: 'p', targetDurationS: 60, status: 'editing' } })
    await prisma.project.create({ data: { ownerId: userId, name: 'meu', prompt: 'p', targetDurationS: 60, status: 'editing' } })
    await prisma.claudeUsageEvent.create({ data: { model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 50 } })
    await prisma.claudeStatus.create({ data: { available: false, reason: 'no_login' } })

    const mine = (await app.inject({ url: '/api/dashboard', headers: user })).json()
    const all = (await app.inject({ url: '/api/dashboard', headers: admin })).json()
    expect(mine.production.editing).toBe(1)
    expect(all.production.editing).toBeGreaterThan(mine.production.editing)
    expect(mine.claude.tokens).toBeDefined() // consumo visível para todos os usuários
    expect(mine.claude.warnings).toEqual([]) // falta de login: aviso só para o admin
    expect(all.claude.warnings[0].text).toMatch(/login/)
    expect(all.claude.tokens.today).toBeGreaterThanOrEqual(150)
    expect(all.claude.byModel).toContainEqual({ model: 'claude-opus-5-5', tokens: 150 }) // gráfico de pizza por modelo
    const pill = (await app.inject({ url: '/api/claude/usage', headers: user })).json()
    expect(pill.tokens).toBeDefined()
    expect(pill.account).toBeUndefined() // o e-mail da conta do Claude fica só para o admin
    expect(all.claude.sessionLeftPct).toBeNull() // sem dados ainda, não zero
    expect(all.claude.plan.name).toBe('Max')
    expect(typeof mine.claude.connected).toBe('boolean')
    expect(mine.claude.account).toBeUndefined() // e-mail da conta do Claude só para o admin
  })
})
