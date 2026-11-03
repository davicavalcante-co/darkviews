import type { FastifyInstance } from 'fastify'
import { prisma } from '@corte/db'
import { FontInput, FontToggle, SettingsInput } from '@corte/shared'
import { requireAdmin, requireAuth } from './auth.js'
import { allFonts, enabledFonts, getSettings } from './settings.js'

export async function adminRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireAdmin }
  const audit = (actorId: string, action: string, targetType: string, targetId: string | null, details: object, ip: string) =>
    prisma.auditLog.create({ data: { actorId, action, targetType, targetId, details: JSON.stringify(details), ip } })

  // ---------- Plano e limites ----------
  app.get('/api/admin/settings', admin, async () => getSettings())

  app.put('/api/admin/settings', admin, async (req) => {
    const input = SettingsInput.parse(req.body)
    const before = await getSettings()
    for (const [key, value] of Object.entries(input)) {
      await prisma.setting.upsert({ where: { key }, update: { value: String(value) }, create: { key, value: String(value) } })
    }
    await audit(req.user!.id, 'settings.update', 'settings', null, { from: before, to: input }, req.ip)
    return input
  })

  // ---------- Fontes ----------
  app.get('/api/fonts', { preHandler: requireAuth }, async () => enabledFonts())

  app.get('/api/admin/fonts', admin, async () => allFonts())

  app.post('/api/admin/fonts', admin, async (req, reply) => {
    const { family } = FontInput.parse(req.body)
    // Confere no Google Fonts antes de liberar (chamada do servidor, nunca do navegador).
    const res = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null)
    if (!res?.ok) return reply.code(400).send({ error: `"${family}" não existe no Google Fonts` })
    await prisma.font.upsert({ where: { family }, update: { enabled: true }, create: { family, weights: '[400,700,900]', enabled: true } })
    await audit(req.user!.id, 'font.enable', 'font', family, { family }, req.ip)
    return reply.code(201).send({ family })
  })

  app.put<{ Params: { family: string } }>('/api/admin/fonts/:family', admin, async (req, reply) => {
    const { enabled } = FontToggle.parse(req.body)
    const family = req.params.family
    if (!(await allFonts()).some((f) => f.family === family)) return reply.code(404).send({ error: 'Fonte não encontrada' })
    if (!enabled && (await enabledFonts()).filter((f) => f !== family).length === 0) return reply.code(409).send({ error: 'Deixe pelo menos uma fonte liberada' })
    await prisma.font.upsert({ where: { family }, update: { enabled }, create: { family, weights: '[400,700,900]', enabled } })
    await audit(req.user!.id, enabled ? 'font.enable' : 'font.disable', 'font', family, { enabled }, req.ip)
    return { ok: true }
  })

  // ---------- Auditoria ----------
  app.get<{ Querystring: { limit?: string } }>('/api/admin/audit', admin, async (req) => {
    const rows = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' }, take: Math.min(Number(req.query.limit) || 100, 500),
      include: { actor: { select: { name: true, email: true } } },
    })
    return rows.map((r) => ({ id: r.id, createdAt: r.createdAt, actor: r.actor?.name ?? 'sistema', action: r.action, targetType: r.targetType, targetId: r.targetId, details: JSON.parse(r.details), ip: r.ip }))
  })
}
