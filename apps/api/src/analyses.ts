import { createReadStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '@corte/db'
import { detectPlatform } from '@corte/shared'
import { requireAuth } from './auth.js'

const Url = z.object({ url: z.string().trim().max(500).refine((v) => !!detectPlatform(v), 'Link precisa ser de YouTube, Instagram, Kwai ou TikTok') })
const card = (a: { id: string; url: string; platform: string | null; title: string | null; channel: string | null; durationS: number | null; status: string; stage: string | null; error: string | null; createdAt: Date; thumbPath: string | null }) =>
  ({ id: a.id, url: a.url, platform: a.platform, title: a.title, channel: a.channel, durationS: a.durationS, status: a.status, stage: a.stage, error: a.error, createdAt: a.createdAt, hasThumb: !!a.thumbPath })

// Aba Análise: envia um link, o worker analisa e o card guarda tudo para usar o estilo num vídeo novo.
export async function analysisRoutes(app: FastifyInstance) {
  const guard = { preHandler: requireAuth }
  const mine = (req: FastifyRequest<{ Params: { id: string } }>) => prisma.videoAnalysis.findFirst({ where: { id: req.params.id, ownerId: req.user!.id } })

  app.get('/api/analyses', guard, async (req) =>
    (await prisma.videoAnalysis.findMany({ where: { ownerId: req.user!.id }, orderBy: { createdAt: 'desc' } })).map(card))

  app.post('/api/analyses', guard, async (req, reply) => {
    const { url } = Url.parse(req.body)
    const a = await prisma.videoAnalysis.create({ data: { ownerId: req.user!.id, url, platform: detectPlatform(url), stage: 'Na fila' } })
    return reply.code(201).send(card(a))
  })

  app.get<{ Params: { id: string } }>('/api/analyses/:id', guard, async (req, reply) => {
    const a = await mine(req)
    if (!a) return reply.code(404).send({ error: 'Análise não encontrada' })
    return { ...card(a), details: a.details ? JSON.parse(a.details) : null, profile: a.profile ? JSON.parse(a.profile) : null }
  })

  app.get<{ Params: { id: string } }>('/api/analyses/:id/thumb', guard, async (req, reply) => {
    const a = await mine(req)
    if (!a?.thumbPath) return reply.code(404).send({ error: 'Sem miniatura' })
    reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=3600')
    return reply.send(createReadStream(a.thumbPath))
  })

  app.post<{ Params: { id: string } }>('/api/analyses/:id/retry', guard, async (req, reply) => {
    const a = await mine(req)
    if (!a || a.status !== 'failed') return reply.code(409).send({ error: 'Só dá para tentar de novo uma análise que falhou' })
    await prisma.videoAnalysis.update({ where: { id: a.id }, data: { status: 'queued', stage: 'Na fila', error: null } })
    return { ok: true }
  })

  app.delete<{ Params: { id: string } }>('/api/analyses/:id', guard, async (req, reply) => {
    const a = await mine(req)
    if (!a) return reply.code(404).send({ error: 'Análise não encontrada' })
    if (a.status === 'running') return reply.code(409).send({ error: 'Espere a análise terminar' })
    await prisma.videoAnalysis.delete({ where: { id: a.id } })
    if (a.thumbPath) await rm(a.thumbPath, { force: true })
    return { ok: true }
  })
}
