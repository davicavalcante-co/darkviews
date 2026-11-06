import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { decryptSecret, encryptSecret, maskSecret, prisma } from '@corte/db'
import { testIntegration } from '@corte/providers'
import { IntegrationUpdate, PROVIDERS } from '@corte/shared'
import { requireAuth } from './auth.js'

const find = (provider: string) => PROVIDERS.find((p) => p.provider === provider)

// Cada usuário tem as suas integrações. O que ele nunca mexeu segue o catálogo: as gratuitas sem chave (builtIn) vêm ligadas.
// Linhas antigas do "padrão para todos" (ownerId = null) são ignoradas.
export async function integrationRoutes(app: FastifyInstance) {
  const base = '/api/integrations'
  const guard = { preHandler: requireAuth }
  const ownerOf = (req: FastifyRequest) => req.user!.id
  const findRow = (provider: string, ownerId: string | null) => prisma.integration.findFirst({ where: { provider, ownerId }, include: { secrets: true } })

  app.get(base, guard, async (req) => {
    const ownerId = ownerOf(req)
    const rows = await prisma.integration.findMany({ where: { ownerId }, include: { secrets: true } })
    return PROVIDERS.map((p) => {
      const row = rows.find((r) => r.provider === p.provider)
      return {
        provider: p.provider, label: p.label, category: p.category, tier: p.tier, help: p.help, signup: p.signup ?? null, tutorial: p.tutorial,
        secrets: p.secrets, choices: p.choices ?? {}, builtIn: !!p.builtIn,
        configured: !!row,
        enabled: row ? row.enabled : !!p.builtIn,
        priority: row?.priority ?? p.priority,
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

  app.put<{ Params: { provider: string } }>(`${base}/:provider`, guard, async (req, reply) => {
    const p = find(req.params.provider)
    if (!p) return reply.code(404).send({ error: 'Integração desconhecida' })
    const input = IntegrationUpdate.parse(req.body)
    const ownerId = ownerOf(req)
    const config = Object.fromEntries(Object.entries(input.config).filter(([k, v]) => k in p.config && (!p.choices?.[k] || p.choices[k].includes(v))))
    const existing = await findRow(p.provider, ownerId)
    const row = existing
      ? await prisma.integration.update({ where: { id: existing.id }, data: { enabled: input.enabled, priority: input.priority, config: JSON.stringify(config) } })
      : await prisma.integration.create({ data: { ownerId, provider: p.provider, category: p.category, enabled: input.enabled, priority: input.priority, config: JSON.stringify(config) } })
    const changed: string[] = []
    for (const [name, value] of Object.entries(input.secrets)) {
      if (!p.secrets.includes(name)) continue
      changed.push(name)
      if (!value) { await prisma.integrationSecret.deleteMany({ where: { integrationId: row.id, name } }); continue }
      const enc = encryptSecret(value)
      await prisma.integrationSecret.upsert({ where: { integrationId_name: { integrationId: row.id, name } }, update: enc, create: { integrationId: row.id, name, ...enc } })
    }
    // Audita o que mudou, nunca o valor da chave.
    await prisma.auditLog.create({
      data: {
        actorId: req.user!.id, action: 'integration.update_own', targetType: 'integration', targetId: row.id, ip: req.ip,
        details: JSON.stringify({ provider: p.provider, enabled: input.enabled, priority: input.priority, secretsChanged: changed }),
      },
    })
    return { ok: true }
  })

  // Volta ao padrão (apaga a preferência do usuário, com as chaves dele).
  app.delete<{ Params: { provider: string } }>(`${base}/:provider`, guard, async (req, reply) => {
    const { count } = await prisma.integration.deleteMany({ where: { provider: req.params.provider, ownerId: req.user!.id } })
    return count ? { ok: true } : reply.code(404).send({ error: 'Você não tem preferência salva para esta integração' })
  })

  app.post<{ Params: { provider: string } }>(`${base}/:provider/test`, guard, async (req, reply: FastifyReply) => {
    const p = find(req.params.provider)
    if (!p) return reply.code(404).send({ error: 'Integração desconhecida' })
    const row = await findRow(p.provider, ownerOf(req))
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
