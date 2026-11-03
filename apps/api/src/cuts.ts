import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '@corte/db'
import { ApproveInput, planCuts, RedoCutInput } from '@corte/shared'
import { requireAuth } from './auth.js'

async function project(req: FastifyRequest<{ Params: { id: string } }>) {
  const where = req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, ownerId: req.user!.id }
  return prisma.project.findFirst({ where, select: { id: true, status: true, approvedAt: true } })
}
const busy = async (projectId: string) => !!(await prisma.job.findFirst({ where: { projectId, status: { in: ['queued', 'running', 'paused'] } } }))

export async function cutRoutes(app: FastifyInstance) {
  const guard = { preHandler: requireAuth }

  app.post<{ Params: { id: string } }>('/api/projects/:id/submit', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (p.status !== 'editing') return reply.code(409).send({ error: 'Só um vídeo em edição pode ir para aprovação' })
    await prisma.project.update({ where: { id: p.id }, data: { status: 'in_approval' } })
    return { ok: true }
  })

  // Aprovar gera os cortes. Também serve para pedir mais cortes de um vídeo já aprovado.
  app.post<{ Params: { id: string } }>('/api/projects/:id/approve', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (!['editing', 'in_approval', 'approved'].includes(p.status)) return reply.code(409).send({ error: 'O vídeo ainda está sendo criado' })
    if (await busy(p.id)) return reply.code(409).send({ error: 'Já existe uma tarefa em andamento neste projeto' })
    const input = ApproveInput.parse(req.body)
    const video = await prisma.videoVersion.findFirst({ where: { projectId: p.id, isCurrent: true } })
    const clean = video && JSON.parse(video.renderSettings).clean
    if (!video || !clean || !existsSync(clean)) {
      return reply.code(409).send({ error: 'Renderize o vídeo de novo antes de aprovar (Edição → Legenda → Salvar e renderizar)' })
    }
    if (input.startS >= video.durationS - 1) return reply.code(400).send({ error: 'O início do trecho passa do fim do vídeo' })
    const plan = planCuts(input, video.durationS)
    await prisma.$transaction([
      prisma.project.update({ where: { id: p.id }, data: { status: 'approved', approvedAt: p.approvedAt ?? new Date() } }),
      prisma.cut.createMany({ data: plan.map((c) => ({ ...c, projectId: p.id, cropX: input.cropX, status: 'queued' })) }),
      prisma.job.create({ data: { projectId: p.id, type: 'cuts', stage: 'Na fila' } }),
    ])
    return reply.code(202).send({ cuts: plan.length })
  })

  app.get<{ Params: { id: string } }>('/api/projects/:id/cuts', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const [cuts, job] = await Promise.all([
      prisma.cut.findMany({
        where: { projectId: p.id }, orderBy: [{ createdAt: 'desc' }, { platform: 'asc' }, { partIndex: 'asc' }],
        select: { id: true, platform: true, partIndex: true, startS: true, endS: true, cropX: true, status: true, createdAt: true },
      }),
      prisma.job.findFirst({ where: { projectId: p.id, status: { in: ['queued', 'running', 'paused'] } }, select: { type: true, stage: true, progress: true, status: true } }),
    ])
    return { status: p.status, approvedAt: p.approvedAt, job, cuts }
  })

  // Refaz um corte com outro enquadramento.
  app.post<{ Params: { id: string; cutId: string } }>('/api/projects/:id/cuts/:cutId/redo', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (await busy(p.id)) return reply.code(409).send({ error: 'Já existe uma tarefa em andamento neste projeto' })
    const { cropX } = RedoCutInput.parse(req.body)
    const { count } = await prisma.cut.updateMany({ where: { id: req.params.cutId, projectId: p.id }, data: { cropX, status: 'queued', filePath: null } })
    if (!count) return reply.code(404).send({ error: 'Corte não encontrado' })
    await prisma.job.create({ data: { projectId: p.id, type: 'cuts', stage: 'Na fila' } })
    return reply.code(202).send({ ok: true })
  })

  app.get<{ Params: { id: string; cutId: string }; Querystring: { download?: string } }>('/api/projects/:id/cuts/:cutId/file', guard, async (req, reply) => {
    const p = await project(req)
    const cut = p && await prisma.cut.findFirst({ where: { id: req.params.cutId, projectId: p.id, status: 'done' } })
    if (!cut?.filePath || !existsSync(cut.filePath)) return reply.code(404).send({ error: 'Corte não encontrado' })
    reply.header('content-type', 'video/mp4').header('content-length', (await stat(cut.filePath)).size)
    if (req.query.download) reply.header('content-disposition', `attachment; filename="${cut.platform}-${cut.partIndex + 1}.mp4"`)
    return reply.send(createReadStream(cut.filePath))
  })
}
