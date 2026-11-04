import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import multipart, { type MultipartFile } from '@fastify/multipart'
import { prisma, type Prisma, sniffFile, STORAGE_DIR, type Sniffed } from '@corte/db'
import { detectPlatform, IMAGE_MAX_BYTES, NewProjectInput, PROVIDERS, ReviewInput, VIDEO_MAX_BYTES, VOICE_PRESETS, VOICE_TONES, type ProgressEvent } from '@corte/shared'
import { z } from 'zod'
import { activeProviders, preferProvider } from '@corte/providers'
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
          options: optionsJson(input),
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

  // Nova versão do mesmo vídeo com os campos ajustados: mesma referência, roteiro novo, e o vídeo novo entra como próxima versão.
  // "order" diz a sequência das imagens: {id} para manter uma já enviada, {new: true} para cada arquivo novo (na ordem do envio).
  app.post<{ Params: { id: string } }>('/api/projects/:id/regenerate', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), include: { assets: { where: { kind: 'user_image' } }, jobs: { where: { status: { in: ['queued', 'running', 'paused'] } } } } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (p.jobs.length) return reply.code(409).send({ error: 'Este vídeo ainda está sendo criado. Espere terminar para gerar outra versão.' })
    const fields: Record<string, string> = {}
    const files: Saved[] = []
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') fields[part.fieldname] = String(part.value)
        else if (part.fieldname === 'images') files.push(await saveUpload(part))
        else throw httpError(400, 'Nesta tela só dá para enviar imagens')
      }
      const input = NewProjectInput.parse({ ...fields, link: undefined })
      const settings = await getSettings()
      if (input.targetDurationS > settings.max_duration_s) throw httpError(400, `Duração máxima definida pelo admin: ${Math.floor(settings.max_duration_s / 60)} min`)
      if (!(await enabledFonts()).includes(input.fontFamily)) throw httpError(400, 'Fonte não liberada pelo admin')
      const order = RegenOrder.parse(JSON.parse(fields.order ?? '[]'))
      if (order.filter((o) => 'new' in o).length !== files.length) throw httpError(400, 'Imagens fora de ordem; tente de novo')
      const owned = new Set(p.assets.map((a) => a.id))
      if (order.some((o) => 'id' in o && !owned.has(o.id))) throw httpError(400, 'Imagem que não é deste vídeo')

      const kept = new Set(order.flatMap((o) => ('id' in o ? [o.id] : [])))
      const dropped = p.assets.filter((a) => !kept.has(a.id))
      let n = 0
      await prisma.$transaction([
        prisma.scene.updateMany({ where: { assetId: { in: dropped.map((a) => a.id) } }, data: { assetId: null } }),
        prisma.asset.deleteMany({ where: { id: { in: dropped.map((a) => a.id) } } }),
        ...order.map((o, i) => ('id' in o
          ? prisma.asset.update({ where: { id: o.id }, data: { sortOrder: i, userCaption: o.caption || null } })
          : prisma.asset.create({ data: { projectId: p.id, kind: 'user_image', filePath: files[n++].path, mime: files[n - 1].mime, sortOrder: i, userCaption: o.caption || null } }))),
        prisma.captionTrack.updateMany({ where: { projectId: p.id }, data: { isCurrent: false } }), // a legenda nova segue o estilo escolhido
        prisma.project.update({ where: { id: p.id }, data: { name: input.name, prompt: input.prompt, targetDurationS: input.targetDurationS, status: 'scripting', options: optionsJson(input, JSON.parse(p.options)) } }),
        prisma.job.create({ data: { projectId: p.id, type: 'script', stage: 'Na fila' } }),
      ])
      await Promise.all(dropped.map((a) => rm(a.filePath, { force: true })))
      return reply.code(202).send({ id: p.id })
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
        videoVersions: { orderBy: { version: 'desc' }, select: { version: true, durationS: true, isCurrent: true } },
        jobs: { where: { status: { in: ['queued', 'running', 'paused'] } }, orderBy: { createdAt: 'desc' }, take: 1, select: { stage: true, progress: true, status: true, etaS: true } },
        _count: { select: { assets: { where: { kind: 'user_image' } } } },
      },
    })
    const tokens = await tokensByProject(rows.map((r) => r.id))
    // Formato da lista e do feed "Criações": prompt resumido, vídeo atual, tarefa em andamento e tokens gastos.
    return rows.map(({ videoVersions, jobs, _count, prompt, ...p }) => ({
      ...p, prompt: prompt.slice(0, 220), video: videoVersions.find((v) => v.isCurrent) ?? null, versions: videoVersions, job: jobs[0] ?? null, images: _count.assets, tokens: tokens.get(p.id) ?? 0,
    }))
  })

  // Estimativa antes de criar: média de tokens por segundo dos vídeos já prontos (de todos), vezes a duração pedida.
  app.get<{ Querystring: { seconds?: string } }>('/api/projects/estimate', { preHandler: requireAuth }, async (req) => {
    const seconds = Math.min(Math.max(Number(req.query.seconds) || 60, 10), 3600)
    const done = await prisma.project.findMany({ where: { status: { in: ['editing', 'in_approval', 'approved'] } }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, targetDurationS: true } })
    const tokens = await tokensByProject(done.map((d) => d.id))
    const used = done.filter((d) => tokens.get(d.id))
    // shortcut: sem histórico usa ~4 mil tokens por segundo de vídeo; a média real assume assim que houver um vídeo pronto.
    const perS = used.length ? used.reduce((n, d) => n + tokens.get(d.id)!, 0) / used.reduce((n, d) => n + d.targetDurationS, 0) : 4000
    return { tokens: Math.round(perS * seconds), basedOn: used.length }
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

  // Vídeo (atual ou a versão pedida), com suporte a Range (o player do navegador pede pedaços). O caminho do arquivo nunca sai daqui.
  app.get<{ Params: { id: string } }>('/api/projects/:id/video', { preHandler: requireAuth }, async (req, reply) => {
    // ?v=N abre uma versão específica (os cards mostram todas); sem ?v, a atual.
    const wanted = Number((req.query as { v?: string }).v) || null
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { videoVersions: { where: wanted ? { version: wanted } : { isCurrent: true } } } })
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

  // Voz que vai narrar os vídeos deste usuário (a primeira pronta) e as opções prontas para escolher em Novo vídeo.
  // Todas as vozes prontas para este usuário, com a origem: "Faber - Masculina (Piper)". O id é "fornecedor:voz".
  app.get('/api/voices', { preHandler: requireAuth }, async (req) => {
    const active = preferProvider(await activeProviders('voz', req.user!.id)) // Piper e macOS por último (erram mais a pronúncia)
    // OmniVoice fica de fora: o modelo dele é não comercial e costuma estar bloqueado pela licença.
    const voices = active.filter((a) => a.provider !== 'omnivoice').flatMap((a) => {
      const label = (PROVIDERS.find((x) => x.provider === a.provider)?.label ?? a.provider).split(' · ')[0].split(' (')[0]
      return (VOICE_PRESETS[a.provider] ?? []).map((v) => ({ id: `${a.provider}:${v.id}`, label: `${v.label} (${label})`, provider: a.provider, freeText: a.provider === 'omnivoice' }))
    })
    // Vozes próprias publicadas na aba Vozes vêm primeiro.
    const own = (await prisma.studioVoice.findMany({ where: { ownerId: req.user!.id, status: 'published' }, orderBy: { name: 'asc' } }))
      .map((v) => ({ id: `studio:${v.id}`, label: `${v.name} (Minha voz)`, provider: 'studio', freeText: false }))
    voices.unshift(...own)
    const first = active[0]
    const current = first && `${first.provider}:${first.config.voice ?? ''}`
    return { voices, current: voices.some((v) => v.id === current) ? current : voices[0]?.id ?? null, tones: VOICE_TONES }
  })


  // ---------- Aprovação das imagens (antes da narração) ----------
  const BANK: Record<string, string> = { pexels: 'Pexels', pixabay: 'Pixabay', openverse: 'Openverse' }
  // A referência tem uma pessoa falando: o cliente escolhe vídeo de banco (JSON {choice:'stock'}) ou envia o vídeo dele (multipart, campo "video").
  app.post<{ Params: { id: string } }>('/api/projects/:id/talking-head', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true, status: true, options: true } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (p.status !== 'talking_head') return reply.code(409).send({ error: 'Este vídeo não está esperando essa escolha' })
    let choice: 'stock' | 'upload' = 'stock'
    if (req.isMultipart()) {
      const part = await req.file()
      if (!part || part.fieldname !== 'video') return reply.code(400).send({ error: 'Envie o vídeo da pessoa falando' })
      const saved = await saveUpload(part)
      await prisma.asset.create({ data: { projectId: p.id, kind: 'user_video', filePath: saved.path, mime: saved.mime, sortOrder: 0 } })
      choice = 'upload'
    } else if ((req.body as { choice?: string } | null)?.choice !== 'stock') return reply.code(400).send({ error: 'Escolha inválida' })
    const ok = await advance(p.id, 'talking_head', { status: 'scripting', options: JSON.stringify({ ...JSON.parse(p.options), talkingHead: choice }) }, 'script')
    if (!ok) return reply.code(409).send({ error: 'Este vídeo não está esperando essa escolha' })
    return reply.code(202).send({ choice })
  })

  app.get<{ Params: { id: string } }>('/api/projects/:id/review', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true, status: true, scripts: { orderBy: { version: 'desc' }, take: 1, select: { id: true } } } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const scenes = await prisma.scene.findMany({
      where: { scriptId: p.scripts[0]?.id ?? '', asset: { kind: { in: ['stock_image', 'stock_video'] } } }, orderBy: { index: 'asc' },
      select: { index: true, narration: true, asset: { select: { id: true, kind: true, sourceProvider: true, attribution: true } } },
    })
    return {
      status: p.status,
      scenes: scenes.map((s) => ({ index: s.index, narration: s.narration, assetId: s.asset!.id, kind: s.asset!.kind === 'stock_video' ? 'video' : 'image', bank: BANK[s.asset!.sourceProvider ?? ''] ?? s.asset!.sourceProvider, credit: s.asset!.attribution })),
    }
  })

  // Arquivo de uma imagem ou vídeo do projeto (para a aprovação). Só o dono ou o admin; o caminho nunca sai do servidor.
  app.get<{ Params: { id: string; assetId: string } }>('/api/projects/:id/assets/:assetId', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true } })
    const a = p && await prisma.asset.findFirst({ where: { id: req.params.assetId, projectId: p.id } })
    if (!a) return reply.code(404).send({ error: 'Arquivo não encontrado' })
    reply.header('content-type', a.mime).header('cache-control', 'private, max-age=3600')
    return reply.send(createReadStream(a.filePath))
  })

  // Aprova o conjunto: sem recusas, segue para a narração; com recusas, só essas cenas ganham uma nova busca (sem repetir a recusada).
  app.post<{ Params: { id: string } }>('/api/projects/:id/review', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true, status: true, scripts: { orderBy: { version: 'desc' }, take: 1, select: { id: true } } } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (p.status !== 'image_review') return reply.code(409).send({ error: 'Este vídeo não está esperando aprovação de imagens' })
    const { rejected } = ReviewInput.parse(req.body)
    const scenes = await prisma.scene.findMany({ where: { scriptId: p.scripts[0]?.id ?? '', index: { in: rejected } }, include: { asset: true } })
    const ok = await advance(p.id, 'image_review', { status: 'media' }, scenes.length ? 'media' : 'voice', (tx) => Promise.all(scenes.filter((s) => s.asset && s.searchQuery).map((s) => {
      const q = JSON.parse(s.searchQuery!)
      return tx.scene.update({ where: { id: s.id }, data: { assetId: null, searchQuery: JSON.stringify({ ...q, rejected: [...(q.rejected ?? []), `${s.asset!.sourceProvider}:${s.asset!.sourceId}`] }) } })
    })))
    if (!ok) return reply.code(409).send({ error: 'Este vídeo não está esperando aprovação de imagens' })
    return reply.code(202).send({ next: scenes.length ? 'nova_busca' : 'narracao', replaced: scenes.length })
  })

  // ---------- Thumbnails (miniaturas do YouTube) ----------
  app.get<{ Params: { id: string } }>('/api/projects/:id/thumbnails', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    return prisma.asset.findMany({ where: { projectId: p.id, kind: 'thumbnail' }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true } })
  })

  app.post<{ Params: { id: string } }>('/api/projects/:id/thumbnails', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const part = await req.file()
    if (!part || part.fieldname !== 'images') return reply.code(400).send({ error: 'Envie a imagem da thumbnail' })
    const saved = await saveUpload(part) // mesma checagem de tipo real e tamanho das imagens enviadas
    if (saved.size > 2 * 1024 * 1024) { await rm(saved.path, { force: true }); return reply.code(413).send({ error: 'O YouTube aceita thumbnails de até 2 MB' }) }
    const a = await prisma.asset.create({ data: { projectId: p.id, kind: 'thumbnail', filePath: saved.path, mime: saved.mime, width: 1280, height: 720 } })
    return reply.code(201).send({ id: a.id })
  })

  // Vídeo que falhou: repete só a etapa que deu erro (o que já ficou pronto é aproveitado).
  const RETRY_STATUS: Record<string, string> = { ingest: 'queued', analyze: 'analyzing', script: 'scripting', media: 'media', voice: 'media', render: 'rendering', regen_part: 'editing' }
  app.post<{ Params: { id: string } }>('/api/projects/:id/retry', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true, status: true } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (await prisma.job.findFirst({ where: { projectId: p.id, status: { in: ['queued', 'running', 'paused'] } } })) return reply.code(409).send({ error: 'Já existe uma tarefa em andamento neste projeto' })
    const failed = await prisma.job.findFirst({ where: { projectId: p.id, status: 'failed' }, orderBy: { createdAt: 'desc' } })
    if (!failed || p.status !== 'failed') return reply.code(409).send({ error: 'Não há etapa com falha para repetir' })
    if (!(await advance(p.id, 'failed', { status: RETRY_STATUS[failed.type] ?? 'queued' }, failed.type, undefined, failed.payload))) return reply.code(409).send({ error: 'Já existe uma tarefa em andamento neste projeto' })
    return reply.code(202).send({ retried: failed.type })
  })

  app.delete<{ Params: { id: string } }>('/api/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({
      where: projectScope(req, req.params.id),
      select: { id: true, status: true, reference: { select: { filePath: true } }, assets: { select: { filePath: true } }, jobs: { where: { status: 'running' }, select: { id: true } } },
    })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    // Com o worker no meio do trabalho ele regravaria os arquivos depois de apagados.
    if (p.jobs.length) return reply.code(409).send({ error: 'Este vídeo ainda está sendo criado. Espere terminar para excluir.' })
    if (req.user!.role !== 'admin' && p.status === 'approved') return reply.code(403).send({ error: 'Projeto aprovado não pode ser excluído' })
    await prisma.project.delete({ where: { id: p.id } })
    // Apaga tudo o que o vídeo usou: envios, referência, imagens, narração, renders, cortes e miniaturas.
    // A biblioteca de músicas locais é compartilhada: nunca apaga de lá.
    const paths = [p.reference?.filePath, ...p.assets.filter((a) => !a.filePath.startsWith(join(STORAGE_DIR, 'music'))).map((a) => a.filePath)].filter((x): x is string => !!x)
    const dirs = ['media', 'renders', 'cuts', 'thumbs'].map((d) => join(STORAGE_DIR, d, p.id))
    await Promise.all([...paths, ...paths.map((f) => `${f}.mask.png`), ...dirs].map((f) => rm(f, { force: true, recursive: true }))) // .mask.png: recorte do parallax
    return { ok: true }
  })
}

// Avança o projeto só se ele ainda estiver no status esperado: num clique duplo o segundo pedido não troca nada e não cria outra tarefa.
async function advance(id: string, from: string, data: { status: string; options?: string }, jobType: string, extra?: (tx: Prisma.TransactionClient) => Promise<unknown>, payload?: string | null) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.project.updateMany({ where: { id, status: from }, data })
    if (!count) return false
    await extra?.(tx)
    await tx.job.create({ data: { projectId: id, type: jobType, payload: payload ?? undefined, stage: 'Na fila' } })
    return true
  })
}

// Soma os tokens do Claude de cada projeto (os eventos de uso ficam ligados às tarefas do projeto).
async function tokensByProject(ids: string[]) {
  const events = await prisma.claudeUsageEvent.findMany({
    where: { job: { projectId: { in: ids } } },
    select: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, job: { select: { projectId: true } } },
  })
  const out = new Map<string, number>()
  for (const e of events) {
    const id = e.job!.projectId
    out.set(id, (out.get(id) ?? 0) + e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens)
  }
  return out
}

// Opções do vídeo guardadas no projeto. Na nova versão, mantém o que veio antes (ex.: a escolha de pessoa falando).
function optionsJson(input: z.infer<typeof NewProjectInput>, prev: Record<string, unknown> = {}) {
  return JSON.stringify({
    ...prev, fontFamily: input.fontFamily, highlightMode: input.highlightMode, voiceBrief: input.voiceBrief, voicePreset: input.voicePreset, voiceTone: input.voiceTone,
    highlightColor: input.highlightColor, captionPosition: input.captionPosition, captionSize: input.captionSize, captionOutline: input.captionOutline,
    bgColor: input.bgColor, useStock: input.useStock, musicStyle: input.musicStyle, musicVolume: input.musicVolume, editStyle: input.editStyle,
  })
}

const RegenOrder = z.array(z.union([z.object({ id: z.string().uuid(), caption: z.string().max(200).default('') }), z.object({ new: z.literal(true), caption: z.string().max(200).default('') })])).max(200)
