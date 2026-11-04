import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import { hash, verify } from '@node-rs/argon2'
import { ZodError } from 'zod'
import { logEvent, prisma, type User } from '@corte/db'
import { CreateUserInput, LoginInput, SetupInput, UpdateUserInput, type PublicUser } from '@corte/shared'
import { csrfFor, newToken, sha256 } from './security.js'
import { requireAdmin, requireAuth } from './auth.js'
import { projectRoutes } from './projects.js'
import { integrationRoutes } from './integrations.js'
import { editRoutes } from './edit.js'
import { cutRoutes } from './cuts.js'
import { adminRoutes } from './admin.js'
import { dashboardRoutes } from './dashboard.js'
import { claudeAuthRoutes } from './claude-auth.js'
import { logRoutes } from './logs.js'
import { claudeMcpRoutes } from './claude-mcp.js'
import { voiceStudioRoutes } from './voice-studio.js'

const SESSION_MS = 7 * 24 * 3600 * 1000
const PUBLIC_MUTATIONS = new Set(['/api/auth/login', '/api/auth/setup'])
// Hash fixo para gastar o mesmo tempo quando o e-mail não existe (não revela quais e-mails existem).
const DUMMY_HASH = await hash('dummy-password-for-timing')

declare module 'fastify' {
  interface FastifyRequest { user: User | null; sessionToken: string | null }
}

const toPublic = (u: User): PublicUser => ({ id: u.id, email: u.email, name: u.name, role: u.role as PublicUser['role'] })


function audit(req: FastifyRequest, action: string, targetType: string, targetId: string | null, details: object = {}) {
  return prisma.auditLog.create({
    data: { actorId: req.user?.id ?? null, action, targetType, targetId, details: JSON.stringify(details), ip: req.ip },
  })
}

export async function buildApp() {
  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]'] },
  })
  await app.register(cookie)
  await app.register(rateLimit, { global: false })

  app.decorateRequest('user', null)
  app.decorateRequest('sessionToken', null)

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Dados inválidos', issues: err.issues })
    const code = (err as { statusCode?: number }).statusCode
    if (code && code >= 400 && code < 500 && code !== 429) return reply.code(code).send({ error: (err as Error).message })
    if (code === 429) return reply.code(429).send({ error: 'Muitas tentativas. Aguarde um minuto.' })
    app.log.error(err)
    logEvent({ level: 'error', source: 'api', kind: 'error', message: `${req.method} ${req.routeOptions.url ?? req.url}: ${(err as Error).message}`,
      details: { stack: (err as Error).stack?.split('\n').slice(0, 10).join('\n') }, userId: req.user?.id })
    return reply.code(500).send({ error: 'Erro interno' })
  })

  app.addHook('onRequest', async (req, reply) => {
    const token = req.cookies.sid
    if (token) {
      const session = await prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } })
      if (session && session.expiresAt > new Date() && session.user.status === 'active') {
        req.user = session.user
        req.sessionToken = token
      }
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return
    // CSRF: toda mutação precisa vir do frontend e, se logado, trazer o token da sessão.
    // O Vite troca de porta quando a 5173 está ocupada (5174, 5175…): aceita qualquer porta do localhost; o token da sessão continua obrigatório.
    if (req.headers.origin !== webOrigin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(req.headers.origin ?? '')) return reply.code(403).send({ error: 'Origem não permitida' })
    if (PUBLIC_MUTATIONS.has(req.routeOptions.url ?? '')) return
    if (req.sessionToken && req.headers['x-csrf-token'] !== csrfFor(req.sessionToken)) {
      return reply.code(403).send({ error: 'Token CSRF inválido' })
    }
  })

  // Toda requisição vira uma linha de log: método, rota, status, tempo e usuário. Sem corpo, cookies ou chaves.
  // A própria tela de logs e os quadros da linha do tempo ficam de fora para não afogar o registro.
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? req.url.split('?')[0]
    if (route === '/api/admin/logs' || route === '/api/projects/:id/frame' || route === '/api/health') return
    const status = reply.statusCode
    logEvent({
      level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', source: 'api', kind: route.startsWith('/api/auth') ? 'auth' : 'request',
      message: `${req.method} ${route} → ${status}`, details: { ms: Math.round(reply.elapsedTime), ip: req.ip }, userId: req.user?.id,
    })
  })

  async function startSession(req: FastifyRequest, reply: FastifyReply, user: User) {
    const token = newToken()
    const expiresAt = new Date(Date.now() + SESSION_MS)
    await prisma.session.create({
      data: { userId: user.id, tokenHash: sha256(token), expiresAt, ip: req.ip, userAgent: req.headers['user-agent'] ?? '' },
    })
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    reply.setCookie('sid', token, {
      httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', path: '/', expires: expiresAt,
    })
    return { user: toPublic(user), csrfToken: csrfFor(token) }
  }

  app.get('/api/health', async () => ({ ok: true }))

  const loginLimit = { rateLimit: { max: 5, timeWindow: '1 minute' } }

  app.post('/api/auth/login', { config: loginLimit }, async (req, reply) => {
    const { email, password } = LoginInput.parse(req.body)
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
    const ok = await verify(user?.passwordHash ?? DUMMY_HASH, password)
    if (!user || !user.passwordHash || !ok || user.status !== 'active') {
      return reply.code(401).send({ error: 'E-mail ou senha incorretos' })
    }
    return startSession(req, reply, user)
  })

  // Primeiro acesso: o seed imprime um token único; quem o tiver define a senha do admin.
  app.post('/api/auth/setup', { config: loginLimit }, async (req, reply) => {
    const { token, password } = SetupInput.parse(req.body)
    const setting = await prisma.setting.findUnique({ where: { key: 'setup_token_hash' } })
    const admin = await prisma.user.findFirst({ where: { role: 'admin', passwordHash: null } })
    if (!setting || !admin || setting.value !== sha256(token)) return reply.code(401).send({ error: 'Token de primeiro acesso inválido' })
    const user = await prisma.user.update({ where: { id: admin.id }, data: { passwordHash: await hash(password) } })
    await prisma.setting.delete({ where: { key: 'setup_token_hash' } })
    req.user = user
    await audit(req, 'admin.first_access', 'user', user.id)
    return startSession(req, reply, user)
  })

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    await prisma.session.deleteMany({ where: { tokenHash: sha256(req.sessionToken!) } })
    reply.clearCookie('sid', { path: '/' })
    return { ok: true }
  })

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => ({
    user: toPublic(req.user!), csrfToken: csrfFor(req.sessionToken!),
  }))

  // ---------- Admin: usuários ----------
  app.get('/api/admin/users', { preHandler: requireAdmin }, async () =>
    prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, name: true, role: true, status: true, lastLoginAt: true, createdAt: true },
    }))

  app.post('/api/admin/users', { preHandler: requireAdmin }, async (req, reply) => {
    const input = CreateUserInput.parse(req.body)
    const email = input.email.toLowerCase()
    if (await prisma.user.findUnique({ where: { email } })) return reply.code(409).send({ error: 'E-mail já cadastrado' })
    const user = await prisma.user.create({
      data: { email, name: input.name, role: input.role, passwordHash: await hash(input.password) },
    })
    await audit(req, 'user.create', 'user', user.id, { email, role: input.role })
    return reply.code(201).send(toPublic(user))
  })

  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const input = UpdateUserInput.parse(req.body)
    const target = await prisma.user.findUnique({ where: { id: req.params.id } })
    if (!target) return reply.code(404).send({ error: 'Usuário não encontrado' })
    const losesAdmin = target.role === 'admin' && target.status === 'active' &&
      (input.role === 'user' || input.status === 'disabled')
    if (losesAdmin) {
      const activeAdmins = await prisma.user.count({ where: { role: 'admin', status: 'active' } })
      if (activeAdmins <= 1) return reply.code(409).send({ error: 'O sistema precisa de pelo menos um admin ativo' })
    }
    const user = await prisma.user.update({ where: { id: target.id }, data: input })
    if (input.status === 'disabled') await prisma.session.deleteMany({ where: { userId: user.id } })
    await audit(req, 'user.update', 'user', user.id, { from: { role: target.role, status: target.status }, to: input })
    return { ...toPublic(user), status: user.status }
  })

  await app.register(projectRoutes)
  await app.register(integrationRoutes)
  await app.register(editRoutes)
  await app.register(cutRoutes)
  await app.register(adminRoutes)
  await app.register(dashboardRoutes)
  await app.register(claudeAuthRoutes)
  await app.register(logRoutes)
  await app.register(claudeMcpRoutes)
  await app.register(voiceStudioRoutes)
  return app
}
