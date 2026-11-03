import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import multipart, { type MultipartFile } from '@fastify/multipart'
import { prisma, sniffFile, STORAGE_DIR, type Sniffed } from '@corte/db'
import { detectPlatform, IMAGE_MAX_BYTES, NewProjectInput, VIDEO_MAX_BYTES, type ProgressEvent } from '@corte/shared'
import { requireAuth } from './auth.js'
import { enabledFonts, getSettings } from './settings.js'

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode })

type Saved = Sniffed & { field: string; path: string; size: number }

// Salva com nome UUID, depois confere o tipo real e o tamanho; se não servir, apaga.
async function saveUpload(part: MultipartFile): Promise<Saved> {
  const dir = join(STORAGE_DIR, 'uploads')
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, randomUUID())
  await pipeline(part.file, createWriteStream(tmp))
  try {
    if (part.file.truncated) throw httpError(413, 'Arquivo maior que 2 GB')
    const type = await sniffFile(tmp)
    const size = (await stat(tmp)).size
    const want = part.fieldname === 'images' ? 'image' : part.fieldname === 'video' ? 'video' : null
    if (!want) throw httpError(400, `Campo de arquivo inesperado: ${part.fieldname}`)
    if (!type || type.kind !== want) {
      throw httpError(415, want === 'image' ? 'Imagens precisam ser JPG, PNG ou WebP' : 'Vídeo precisa ser MP4, MOV ou WebM')
    }
    if (type.kind === 'image' && size > IMAGE_MAX_BYTES) throw httpError(413, 'Cada imagem pode ter até 20 MB')
    if (type.kind === 'video' && size > VIDEO_MAX_BYTES) throw httpError(413, 'Vídeo pode ter até 2 GB')
    return { ...type, field: part.fieldname, path: tmp, size }
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

// Usuário comum só enxerga os próprios projetos; o de outra pessoa vira 404.
function projectScope(req: FastifyRequest, id: string) {
  return req.user!.role === 'admin' ? { id } : { id, ownerId: req.user!.id }
}

async function progressOf(projectId: string): Promise<ProgressEvent | null> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true, jobs: { orderBy: { createdAt: 'desc' }, take: 1 } },
  })
  if (!p) return null
  const j = p.jobs[0]
  return {
    status: p.status as ProgressEvent['status'],
    job: j ? { type: j.type, status: j.status, stage: j.stage, progress: j.progress, etaS: j.etaS, error: j.error } : null,
  }
}

export async function projectRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: VIDEO_MAX_BYTES, files: 200, fields: 20, fieldSize: 100_000 } })

  app.post('/api/projects', { preHandler: requireAuth }, async (req, reply) => {
    const fields: Record<string, string> = {}
    const files: Saved[] = []
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') fields[part.fieldname] = String(part.value)
        else files.push(await saveUpload(part))
      }
      const input = NewProjectInput.parse(fields)
      const settings = await getSettings()
      if (input.targetDurationS > settings.max_duration_s) throw httpError(400, `Duração máxima definida pelo admin: ${Math.floor(settings.max_duration_s / 60)} min`)
      if (!(await enabledFonts()).includes(input.fontFamily)) throw httpError(400, 'Fonte não liberada pelo admin')
      if (settings.daily_video_limit > 0) {
        const today = await prisma.project.count({ where: { ownerId: req.user!.id, createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } })
        if (today >= settings.daily_video_limit) throw httpError(429, `Limite de ${settings.daily_video_limit} vídeos por dia atingido`)
      }
      const video = files.filter((f) => f.field === 'video')
      const images = files.filter((f) => f.field === 'images')
      if (video.length > 1) throw httpError(400, 'Envie só um vídeo de referência')
      if (video.length && input.link) throw httpError(400, 'Use link ou vídeo de referência, não os dois')

      const project = await prisma.project.create({
        data: {
          ownerId: req.user!.id,
          name: input.name,
          prompt: input.prompt,
          targetDurationS: input.targetDurationS,
          options: JSON.stringify({ fontFamily: input.fontFamily, highlightMode: input.highlightMode, voiceBrief: input.voiceBrief }),
          reference: input.link
            ? { create: { sourceType: 'link', url: input.link, platform: detectPlatform(input.link) } }
            : video[0] ? { create: { sourceType: 'upload', filePath: video[0].path } } : undefined,
          assets: {
            create: images.map((f, i) => ({
              kind: 'user_image', filePath: f.path, mime: f.mime, sortOrder: i, userCaption: input.captions[i] || null,
            })),
          },
          jobs: { create: { type: 'ingest', stage: 'Na fila' } },
        },
      })
      return reply.code(201).send({ id: project.id })
    } catch (e) {
      await Promise.all(files.map((f) => rm(f.path, { force: true })))
      throw e
    }
  })

  app.get('/api/projects', { preHandler: requireAuth }, async (req) => {
    const rows = await prisma.project.findMany({
      where: req.user!.role === 'admin' ? {} : { ownerId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, prompt: true, status: true, targetDurationS: true, aspect: true, createdAt: true, owner: { select: { name: true } },
        videoVersions: { where: { isCurrent: true }, select: { version: true, durationS: true } },
        jobs: { where: { status: { in: ['queued', 'running', 'paused'] } }, orderBy: { createdAt: 'desc' }, take: 1, select: { stage: true, progress: true, status: true, etaS: true } },
        _count: { select: { assets: { where: { kind: 'user_image' } } } },
      },
    })
    // Formato da lista e do feed "Criações": prompt resumido, vídeo atual e tarefa em andamento.
    return rows.map(({ videoVersions, jobs, _count, prompt, ...p }) => ({
      ...p, prompt: prompt.slice(0, 220), video: videoVersions[0] ?? null, job: jobs[0] ?? null, images: _count.assets,
    }))
  })

  app.get<{ Params: { id: string } }>('/api/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({
      where: projectScope(req, req.params.id),
      select: {
        id: true, name: true, prompt: true, status: true, targetDurationS: true, options: true, createdAt: true,
        reference: { select: { sourceType: true, platform: true, url: true, durationS: true, styleProfile: true } },
        scripts: { orderBy: { version: 'desc' }, take: 1, select: { version: true, body: true, scenes: { orderBy: { index: 'asc' }, select: { index: true, startS: true, endS: true, narration: true, onScreenText: true, assetId: true, searchQuery: true, transition: true } } } },
        metadataFields: { where: { isCurrent: true }, select: { field: true, value: true } },
        videoVersions: { where: { isCurrent: true }, select: { version: true, durationS: true } },
        assets: { where: { kind: 'user_image' }, orderBy: { sortOrder: 'asc' }, select: { id: true, userCaption: true, sortOrder: true } },
      },
    })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const { scripts, metadataFields, reference, videoVersions, ...rest } = p
    return {
      ...rest,
      options: JSON.parse(p.options),
      reference: reference && { ...reference, styleProfile: reference.styleProfile ? JSON.parse(reference.styleProfile) : null },
      script: scripts[0] ?? null,
      metadata: Object.fromEntries(metadataFields.map((m) => [m.field, m.value])),
      video: videoVersions[0] ?? null,
    }
  })

  // Server-Sent Events: manda o estado sempre que mudar.
  app.get<{ Params: { id: string } }>('/api/projects/:id/events', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    reply.hijack()
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    let last = ''
    const tick = async () => {
      const json = JSON.stringify(await progressOf(p.id))
      if (json !== last) { last = json; reply.raw.write(`data: ${json}\n\n`) }
    }
    await tick()
    // shortcut: consulta o banco a cada 1 s por conexão; trocar por eventos do worker se houver muitos espectadores.
    const timer = setInterval(() => tick().catch(() => {}), 1000)
    req.raw.on('close', () => clearInterval(timer))
  })

  // Vídeo atual, com suporte a Range (o player do navegador pede pedaços). O caminho do arquivo nunca sai daqui.
  app.get<{ Params: { id: string } }>('/api/projects/:id/video', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { videoVersions: { where: { isCurrent: true } } } })
    const v = p?.videoVersions[0]
    if (!v) return reply.code(404).send({ error: 'Vídeo não encontrado' })
    const size = (await stat(v.filePath)).size
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
    const start = m?.[1] ? Number(m[1]) : 0
    const end = m?.[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start > end) return reply.code(416).header('content-range', `bytes */${size}`).send()
    reply.header('accept-ranges', 'bytes').header('content-type', 'video/mp4').header('content-length', end - start + 1)
    if (m) reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`)
    if ((req.query as { download?: string }).download) reply.header('content-disposition', `attachment; filename="video-v${v.version}.mp4"`)
    return reply.send(createReadStream(v.filePath, { start, end }))
  })

  // Vídeo que falhou: repete só a etapa que deu erro (o que já ficou pronto é aproveitado).
  const RETRY_STATUS: Record<string, string> = { ingest: 'queued', analyze: 'analyzing', script: 'scripting', media: 'media', render: 'rendering', regen_part: 'editing' }
  app.post<{ Params: { id: string } }>('/api/projects/:id/retry', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true, status: true } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (await prisma.job.findFirst({ where: { projectId: p.id, status: { in: ['queued', 'running', 'paused'] } } })) return reply.code(409).send({ error: 'Já existe uma tarefa em andamento neste projeto' })
    const failed = await prisma.job.findFirst({ where: { projectId: p.id, status: 'failed' }, orderBy: { createdAt: 'desc' } })
    if (!failed || p.status !== 'failed') return reply.code(409).send({ error: 'Não há etapa com falha para repetir' })
    await prisma.$transaction([
      prisma.job.create({ data: { projectId: p.id, type: failed.type, payload: failed.payload, stage: 'Na fila' } }),
      prisma.project.update({ where: { id: p.id }, data: { status: RETRY_STATUS[failed.type] ?? 'queued' } }),
    ])
    return reply.code(202).send({ retried: failed.type })
  })

  app.delete<{ Params: { id: string } }>('/api/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({
      where: projectScope(req, req.params.id),
      select: { id: true, status: true, reference: { select: { filePath: true } }, assets: { select: { filePath: true } } },
    })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (req.user!.role !== 'admin' && p.status === 'approved') return reply.code(403).send({ error: 'Projeto aprovado não pode ser excluído' })
    await prisma.project.delete({ where: { id: p.id } })
    const paths = [p.reference?.filePath, ...p.assets.map((a) => a.filePath)].filter((x): x is string => !!x)
    await Promise.all(paths.map((f) => rm(f, { force: true })))
    return { ok: true }
  })
}
