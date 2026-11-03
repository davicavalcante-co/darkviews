import type { FastifyInstance } from 'fastify'
import { prisma } from '@corte/db'
import { claudeWarnings } from '@corte/shared'
import { requireAuth } from './auth.js'
import { getSettings } from './settings.js'
import { claudeAccount } from './claude-auth.js'
import { claudeCodeUsage } from './claude-code-usage.js'

const DAY = 86_400_000
const sumTokens = (rows: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }[]) =>
  rows.reduce((n, r) => n + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens, 0)

// Bloco do Claude: o Painel e a barra flutuante do topo usam o mesmo formato.
export async function claudeBlock(isAdmin: boolean) {
  const status = await prisma.claudeStatus.findFirst({ orderBy: { checkedAt: 'desc' } })
  const account = await claudeAccount()
  const claude: Record<string, unknown> = {
    connected: account.connected,
    available: status?.available ?? null,
    checkedAt: status?.checkedAt ?? null,
    warnings: claudeWarnings(status, isAdmin),
  }
  // Usuário comum vê só status e avisos; números e histórico ficam para o admin.
  if (isAdmin) {
    const now = Date.now()
    const today = new Date(new Date().setHours(0, 0, 0, 0))
    const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    const sessionStart = status?.sessionResetsAt ? new Date(status.sessionResetsAt.getTime() - 5 * 3600_000) : new Date(now - 5 * 3600_000)
    // Tokens do Claude Code: histórico local da máquina + chamadas do Corte Final (que não entram no histórico).
    const appEvents = await prisma.claudeUsageEvent.findMany({ where: { createdAt: { gte: new Date(now - 31 * DAY) } } })
    const code = await claudeCodeUsage()
    const usage = [
      ...code.map((u) => ({ at: u.at, model: u.model, tokens: u.tokens, app: false })),
      ...appEvents.map((e) => ({ at: e.createdAt, model: e.model, tokens: sumTokens([e]), app: true })),
    ]
    const sum = (from: Date, to = new Date(now + DAY)) => usage.filter((u) => u.at >= from && u.at < to).reduce((n, u) => n + u.tokens, 0)
    const last30 = usage.filter((u) => u.at.getTime() >= now - 30 * DAY)
    const byModel = [...new Set(last30.map((u) => u.model))].map((model) => ({ model, tokens: last30.filter((u) => u.model === model).reduce((n, u) => n + u.tokens, 0) }))
      .sort((a, b) => b.tokens - a.tokens)
    const settings = await getSettings()
    const renews = settings.plan_renews_at ? new Date(`${settings.plan_renews_at}T00:00:00`) : null
    Object.assign(claude, {
      tokens: { today: sum(today), session: sum(sessionStart), month: sum(month) },
      // Quanto do mês veio do próprio Corte Final (o resto é o uso do Claude Code fora dele).
      tokensApp: { month: usage.filter((u) => u.app && u.at >= month).reduce((n, u) => n + u.tokens, 0) },
      // null = "sem dados ainda" (o rate limit só chega depois da primeira resposta), nunca zero.
      sessionLeftPct: status?.sessionUsedPct == null ? null : Math.max(0, 100 - status.sessionUsedPct),
      sessionResetsAt: status?.sessionResetsAt ?? null,
      weekLeftPct: status?.weekUsedPct == null ? null : Math.max(0, 100 - status.weekUsedPct),
      weekResetsAt: status?.weekResetsAt ?? null,
      account: { email: account.email, organization: account.organization },
      subscription: status?.subscriptionType ?? account.subscription ?? null,
      plan: { name: settings.plan_name || null, renewsAt: settings.plan_renews_at || null, daysLeft: renews ? Math.ceil((renews.getTime() - now) / DAY) : null },
      byModel,
      history: Array.from({ length: 14 }, (_, i) => {
        const d = new Date(today.getTime() - (13 - i) * DAY)
        return { day: d.toISOString().slice(0, 10), tokens: sum(d, new Date(d.getTime() + DAY)) }
      }),
    })
  }

  return claude
}

export async function dashboardRoutes(app: FastifyInstance) {
  // Leve: só o Claude, para a barra flutuante que aparece em todas as telas.
  app.get('/api/claude/usage', { preHandler: requireAuth }, async (req) => claudeBlock(req.user!.role === 'admin'))

  app.get('/api/dashboard', { preHandler: requireAuth }, async (req) => {
    const isAdmin = req.user!.role === 'admin'
    const scope = isAdmin ? {} : { ownerId: req.user!.id }
    const groups = await prisma.project.groupBy({ by: ['status'], where: scope, _count: true })
    const count = (...st: string[]) => groups.filter((g) => st.includes(g.status)).reduce((n, g) => n + g._count, 0)
    const cuts = await prisma.cut.count({ where: { status: 'done', project: scope } })
    // Entregas (aprovações) por semana, últimas 8 semanas.
    const since = new Date(Date.now() - 8 * 7 * DAY)
    const approved = await prisma.project.findMany({ where: { ...scope, approvedAt: { gte: since } }, select: { approvedAt: true } })
    const weeks = Array.from({ length: 8 }, (_, i) => {
      const start = new Date(since.getTime() + i * 7 * DAY)
      return { start, count: approved.filter((p) => p.approvedAt! >= start && p.approvedAt! < new Date(start.getTime() + 7 * DAY)).length }
    })

    const claude = await claudeBlock(isAdmin)

    return {
      production: {
        analyzing: count('queued', 'analyzing'),
        creating: count('scripting', 'media', 'rendering'),
        editing: count('editing'),
        inApproval: count('in_approval'),
        approved: count('approved'),
        failed: count('failed'),
        cuts,
        weeks,
      },
      claude,
    }
  })
}
