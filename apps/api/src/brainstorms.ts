import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '@corte/db'
import { requireAuth } from './auth.js'

const Input = z.object({ niche: z.string().trim().min(2).max(200), notes: z.string().trim().max(2000).optional() })
const view = (b: { id: string; niche: string; notes: string | null; status: string; error: string | null; ideas: string | null; createdAt: Date; startedAt: Date | null; finishedAt: Date | null; tokens: number | null }) =>
  ({ id: b.id, niche: b.niche, notes: b.notes, status: b.status, error: b.error, createdAt: b.createdAt, startedAt: b.startedAt, finishedAt: b.finishedAt, tokens: b.tokens, result: b.ideas ? JSON.parse(b.ideas) : null })

// Aba Brainstorm: a pessoa escreve o nicho; o worker pesquisa e traz ideias de vídeo.
export async function brainstormRoutes(app: FastifyInstance) {
  const guard = { preHandler: requireAuth }
  const mine = (req: FastifyRequest<{ Params: { id: string } }>) => prisma.brainstorm.findFirst({ where: { id: req.params.id, ownerId: req.user!.id } })
  app.get('/api/brainstorms', guard, async (req) => (await prisma.brainstorm.findMany({ where: { ownerId: req.user!.id }, orderBy: { createdAt: 'desc' } })).map(view))
  app.post('/api/brainstorms', guard, async (req, reply) => {
    const input = Input.parse(req.body)
    return reply.code(201).send(view(await prisma.brainstorm.create({ data: { ownerId: req.user!.id, niche: input.niche, notes: input.notes || null } })))
  })
  app.post<{ Params: { id: string } }>('/api/brainstorms/:id/retry', guard, async (req, reply) => {
    const b = await mine(req)
    if (!b || b.status !== 'failed') return reply.code(409).send({ error: 'Só dá para tentar de novo o que falhou' })
    await prisma.brainstorm.update({ where: { id: b.id }, data: { status: 'queued', error: null } })
    return { ok: true }
  })
  // Parar: tira da fila ou interrompe o que travou; depois dá para Tentar de novo ou Excluir.
  app.post<{ Params: { id: string } }>('/api/brainstorms/:id/stop', guard, async (req, reply) => {
    const x = await mine(req)
    if (!x) return reply.code(404).send({ error: 'Não encontrado' })
    await prisma.brainstorm.updateMany({ where: { id: x.id, status: { in: ['queued', 'running'] } }, data: { status: 'failed', error: 'Parado por você', finishedAt: new Date() } })
    return { ok: true }
  })
  app.delete<{ Params: { id: string } }>('/api/brainstorms/:id', guard, async (req, reply) => {
    const b = await mine(req)
    if (!b) return reply.code(404).send({ error: 'Não encontrado' })
    await prisma.brainstorm.delete({ where: { id: b.id } })
    return { ok: true }
  })
}
