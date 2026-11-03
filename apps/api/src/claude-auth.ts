import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '@corte/db'
import { requireAdmin } from './auth.js'

const run = promisify(execFile)

// Login do Claude Code desta máquina. Quem autoriza é sempre o admin, no site do Claude;
// o servidor só repassa o link e o código que o próprio site mostra.
type Login = { proc: ChildProcessWithoutNullStreams; url: string | null; output: string; exit: Promise<number | null> }
let login: Login | null = null

export type ClaudeAccount = { connected: boolean; email: string | null; organization: string | null; subscription: string | null }

let cache: { at: number; value: ClaudeAccount } | null = null
export async function claudeAccount(force = false): Promise<ClaudeAccount> {
  if (!force && cache && Date.now() - cache.at < 15_000) return cache.value
  let value: ClaudeAccount = { connected: false, email: null, organization: null, subscription: null }
  try {
    const { stdout } = await run('claude', ['auth', 'status'], { timeout: 20_000 })
    const s = JSON.parse(stdout)
    // Só o que a tela precisa: nada de token ou caminho de credencial.
    value = { connected: !!s.loggedIn || !!process.env.CLAUDE_CODE_OAUTH_TOKEN, email: s.email ?? null, organization: s.orgName ?? null, subscription: s.subscriptionType ?? null }
  } catch {
    value.connected = !!process.env.CLAUDE_CODE_OAUTH_TOKEN
  }
  cache = { at: Date.now(), value }
  return value
}

function stopLogin() {
  login?.proc.kill()
  login = null
}

const CodeInput = z.object({ code: z.string().trim().min(10).max(2000).regex(/^[^\s]+$/, 'Cole só o código, sem espaços') })

export async function claudeAuthRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireAdmin }
  const audit = (actorId: string, action: string, ip: string) =>
    prisma.auditLog.create({ data: { actorId, action, targetType: 'claude', targetId: null, details: '{}', ip } })

  app.get('/api/admin/claude', admin, async () => ({ ...(await claudeAccount(true)), pending: !!login, url: login?.url ?? null }))

  // Passo 1: abre o login. O navegador desta máquina abre sozinho; o link também volta para a tela.
  app.post('/api/admin/claude/connect', admin, async (req, reply) => {
    if ((await claudeAccount(true)).connected) return reply.code(409).send({ error: 'O Claude já está conectado neste computador' })
    stopLogin()
    const proc = spawn('claude', ['auth', 'login'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const current: Login = { proc, url: null, output: '', exit: new Promise((r) => proc.on('close', r)) }
    login = current
    const onData = (d: Buffer) => {
      current.output += d.toString()
      current.url ??= current.output.match(/https:\/\/claude\.com\/\S+/)?.[0] ?? null
    }
    proc.stdout.on('data', onData); proc.stderr.on('data', onData)
    proc.on('error', () => { if (login === current) login = null })
    // Espera o link aparecer (até 15 s).
    for (let i = 0; i < 30 && !current.url && login === current; i++) await new Promise((r) => setTimeout(r, 500))
    if (!current.url) { stopLogin(); return reply.code(500).send({ error: 'Não foi possível iniciar o login. Confira se o Claude Code está instalado (comando claude).' }) }
    await audit(req.user!.id, 'claude.connect_start', req.ip)
    return { url: current.url }
  })

  // Passo 2: o admin cola o código que o site do Claude mostrou depois de autorizar.
  app.post('/api/admin/claude/code', admin, async (req, reply) => {
    const { code } = CodeInput.parse(req.body)
    const current = login
    if (!current) return reply.code(409).send({ error: 'Clique em "Conectar ao Claude" primeiro' })
    const before = current.output.length
    current.proc.stdin.write(code + '\n')
    const exit = await Promise.race([current.exit, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 60_000))])
    const answer = current.output.slice(before)
    if (login === current) login = null
    const ok = exit === 0 || /login successful/i.test(answer)
    if (!ok) {
      current.proc.kill()
      return reply.code(400).send({ error: exit === 'timeout' ? 'O login demorou demais. Tente de novo.' : 'Código recusado. Clique em "Conectar ao Claude" e tente de novo.' })
    }
    await audit(req.user!.id, 'claude.connected', req.ip)
    return claudeAccount(true)
  })

  app.post('/api/admin/claude/cancel', admin, async () => { stopLogin(); return { ok: true } })
}
