import type { FastifyInstance } from 'fastify'
import { decryptSecret, encryptSecret, maskSecret, prisma } from '@corte/db'
import { testIntegration } from '@corte/providers'
import { IntegrationUpdate, PROVIDERS } from '@corte/shared'
import { requireAdmin } from './auth.js'

const find = (provider: string) => PROVIDERS.find((p) => p.provider === provider)

export async function integrationRoutes(app: FastifyInstance) {
  // Lista o catálogo com o estado salvo. Chaves aparecem só mascaradas (últimos 4 caracteres).
  app.get('/api/admin/integrations', { preHandler: requireAdmin }, async () => {
    const rows = await prisma.integration.findMany({ include: { secrets: true } })
    return PROVIDERS.map((p) => {
      const row = rows.find((r) => r.provider === p.provider)
      return {
        ...p,
        enabled: row ? row.enabled : !!p.builtIn,
        priority: row?.priority ?? 50,
        config: { ...p.config, ...(row ? JSON.parse(row.config) : {}) },
        secretsSet: Object.fromEntries(p.secrets.map((name) => {
          const s = row?.secrets.find((x) => x.name === name)
          return [name, s ? maskSecret(s.last4) : null]
        })),
        lastTestAt: row?.lastTestAt ?? null,
        lastTestOk: row?.lastTestOk ?? null,
      }
    })
  })

  app.put<{ Params: { provider: string } }>('/api/admin/integrations/:provider', { preHandler: requireAdmin }, async (req, reply) => {
    const p = find(req.params.provider)
    if (!p) return reply.code(404).send({ error: 'Integração desconhecida' })
    const input = IntegrationUpdate.parse(req.body)
    const config = Object.fromEntries(Object.entries(input.config).filter(([k]) => k in p.config))
    const row = await prisma.integration.upsert({
      where: { id: (await prisma.integration.findFirst({ where: { provider: p.provider } }))?.id ?? '' },
      update: { enabled: input.enabled, priority: input.priority, config: JSON.stringify(config) },
      create: { provider: p.provider, category: p.category, enabled: input.enabled, priority: input.priority, config: JSON.stringify(config) },
    })
    const changed: string[] = []
    for (const [name, value] of Object.entries(input.secrets)) {
      if (!p.secrets.includes(name)) continue
      changed.push(name)
      if (!value) { await prisma.integrationSecret.deleteMany({ where: { integrationId: row.id, name } }); continue }
      const enc = encryptSecret(value)
      await prisma.integrationSecret.upsert({
        where: { integrationId_name: { integrationId: row.id, name } },
        update: enc, create: { integrationId: row.id, name, ...enc },
      })
    }
    // Audita o que mudou, nunca o valor da chave.
    await prisma.auditLog.create({
      data: {
        actorId: req.user!.id, action: 'integration.update', targetType: 'integration', targetId: row.id, ip: req.ip,
        details: JSON.stringify({ provider: p.provider, enabled: input.enabled, priority: input.priority, secretsChanged: changed }),
      },
    })
    return { ok: true }
  })

  app.post<{ Params: { provider: string } }>('/api/admin/integrations/:provider/test', { preHandler: requireAdmin }, async (req, reply) => {
    const p = find(req.params.provider)
    if (!p) return reply.code(404).send({ error: 'Integração desconhecida' })
    const row = await prisma.integration.findFirst({ where: { provider: p.provider }, include: { secrets: true } })
    if (p.secrets.some((n) => !row?.secrets.find((s) => s.name === n))) return reply.code(400).send({ error: 'Cadastre a chave antes de testar' })
    const ok = await testIntegration(
      p.provider,
      Object.fromEntries((row?.secrets ?? []).map((s) => [s.name, decryptSecret(s)])),
      { ...p.config, ...(row ? JSON.parse(row.config) : {}) },
    )
    if (row) await prisma.integration.update({ where: { id: row.id }, data: { lastTestAt: new Date(), lastTestOk: ok } })
    return { ok }
  })
}
