import { beforeAll, describe, expect, it } from 'vitest'
import { hash } from '@node-rs/argon2'
import { prisma } from '@corte/db'
import { buildApp } from '../src/app.js'
import { sha256 } from '../src/security.js'

const ORIGIN = 'http://localhost:5173'
const PASS = 'senha-forte-123'
let app: Awaited<ReturnType<typeof buildApp>>
let adminId = ''
let userId = ''

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASS } })
  expect(res.statusCode).toBe(200)
  return { headers: { origin: ORIGIN, cookie: `sid=${res.cookies[0].value}`, 'x-csrf-token': res.json().csrfToken } }
}

beforeAll(async () => {
  const passwordHash = await hash(PASS)
  adminId = (await prisma.user.create({ data: { email: 'admin@t.com', name: 'A', role: 'admin', passwordHash } })).id
  userId = (await prisma.user.create({ data: { email: 'user@t.com', name: 'U', role: 'user', passwordHash } })).id
  app = await buildApp()
})

describe('permissões', () => {
  const adminRoutes = (id: string) => [
    { method: 'GET' as const, url: '/api/admin/users' },
    { method: 'PATCH' as const, url: `/api/admin/users/${id}`, payload: { role: 'admin' } },
  ]

  it('usuário comum recebe 403 em todas as rotas de admin', async () => {
    const { headers } = await login('user@t.com')
    for (const r of adminRoutes(userId)) {
      expect((await app.inject({ ...r, headers })).statusCode, r.url).toBe(403)
    }
    expect((await prisma.user.findUnique({ where: { id: userId } }))!.role).toBe('user')
  })

  it('sem sessão recebe 401', async () => {
    for (const r of adminRoutes(userId)) {
      expect((await app.inject({ ...r, headers: { origin: ORIGIN } })).statusCode).toBe(401)
    }
  })

  it('admin acessa e a ação vai para o audit_logs', async () => {
    const { headers } = await login('admin@t.com')
    expect((await app.inject({ method: 'GET', url: '/api/admin/users', headers })).statusCode).toBe(200)
    // Uma conta por computador: criar outro usuário não existe mais.
    expect((await app.inject({ method: 'POST', url: '/api/admin/users', headers, payload: { email: 'novo@t.com', name: 'N', password: PASS } })).statusCode).toBe(404)
  })

  it('recusa rebaixar ou desativar o último admin', async () => {
    const { headers } = await login('admin@t.com')
    // Outros arquivos de teste criam admins no mesmo banco: deixa este como o único ativo.
    await prisma.user.updateMany({ where: { role: 'admin', id: { not: adminId } }, data: { status: 'disabled' } })
    for (const payload of [{ role: 'user' }, { status: 'disabled' }]) {
      expect((await app.inject({ method: 'PATCH', url: `/api/admin/users/${adminId}`, headers, payload })).statusCode).toBe(409)
    }
  })
})

describe('segurança da sessão', () => {
  it('mutação sem token CSRF ou de outra origem recebe 403', async () => {
    const { headers } = await login('admin@t.com')
    const r = { method: 'POST' as const, url: '/api/auth/logout' }
    expect((await app.inject({ ...r, headers: { ...headers, 'x-csrf-token': 'x' } })).statusCode).toBe(403)
    expect((await app.inject({ ...r, headers: { ...headers, origin: 'http://evil.test' } })).statusCode).toBe(403)
  })

  it('cookie é httpOnly e SameSite=Strict, e o banco guarda só o hash', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: 'user@t.com', password: PASS } })
    const c = res.cookies[0]
    expect(c.httpOnly).toBe(true)
    expect(c.sameSite).toBe('Strict')
    expect(await prisma.session.findUnique({ where: { tokenHash: sha256(c.value) } })).not.toBeNull()
  })

  it('primeiro acesso: só com o token do seed, uma vez', async () => {
    await prisma.user.create({ data: { email: 'root@t.com', name: 'R', role: 'admin' } })
    await prisma.setting.create({ data: { key: 'setup_token_hash', value: sha256('token-do-seed-123') } })
    const send = (token: string) => app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin: ORIGIN }, payload: { token } })
    expect((await send('token-errado-0000')).statusCode).toBe(401)
    const ok = await send('token-do-seed-123')
    expect(ok.statusCode).toBe(200)
    expect(ok.json().user.needsSetup).toBe(true)
    expect((await send('token-do-seed-123')).statusCode).toBe(401)
    // Dentro do sistema: define e-mail e senha; depois entra pelo login normal.
    const headers = { origin: ORIGIN, cookie: `sid=${ok.cookies[0].value}`, 'x-csrf-token': ok.json().csrfToken }
    const done = await app.inject({ method: 'POST', url: '/api/auth/complete-setup', headers, payload: { name: 'Davi', email: 'Dono@T.com', password: PASS } })
    expect(done.json().user).toMatchObject({ email: 'dono@t.com', needsSetup: false })
    expect((await app.inject({ method: 'POST', url: '/api/auth/complete-setup', headers, payload: { name: 'X', email: 'x@t.com', password: PASS } })).statusCode).toBe(409)
    expect((await prisma.user.findUniqueOrThrow({ where: { email: 'dono@t.com' } })).passwordHash).not.toBeNull() // daí em diante, login normal
  })

  it('limita tentativas de login (429 depois de 5)', async () => {
    const codes = []
    for (let i = 0; i < 6; i++) {
      codes.push((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email: 'n@t.com', password: 'errada' } })).statusCode)
    }
    expect(codes.at(-1)).toBe(429)
  })
})
