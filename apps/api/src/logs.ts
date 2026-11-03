import type { FastifyInstance } from 'fastify'
import { prisma } from '@corte/db'
import { requireAdmin } from './auth.js'

type Q = { level?: string; source?: string; kind?: string; q?: string; before?: string; limit?: string }

export async function logRoutes(app: FastifyInstance) {
  // Aba Logs (só admin): filtros por nível, origem, tipo e texto; paginação pelo horário do último item.
  app.get<{ Querystring: Q }>('/api/admin/logs', { preHandler: requireAdmin }, async (req) => {
    const { level, source, kind, q, before } = req.query
    const rows = await prisma.systemLog.findMany({
      where: {
        ...(level && { level: { in: level.split(',') } }),
        ...(source && { source }),
        ...(kind && { kind: { in: kind.split(',') } }),
        ...(q && { OR: [{ message: { contains: q } }, { details: { contains: q } }] }),
        ...(before && { createdAt: { lt: new Date(before) } }),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(req.query.limit) || 100, 500),
    })
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId).filter(Boolean))] as string[] } }, select: { id: true, name: true } })
    const counts = await prisma.systemLog.groupBy({ by: ['level'], where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } }, _count: true })
    return {
      last24h: Object.fromEntries(counts.map((c) => [c.level, c._count])),
      rows: rows.map((r) => ({ ...r, details: JSON.parse(r.details), user: users.find((u) => u.id === r.userId)?.name ?? null })),
    }
  })
}
