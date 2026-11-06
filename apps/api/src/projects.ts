import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import multipart, { type MultipartFile } from '@fastify/multipart'
import { estimateSeconds, prisma, type Prisma, sniffFile, STORAGE_DIR, type Sniffed } from '@corte/db'
import { detectPlatform, IMAGE_MAX_BYTES, NewProjectInput, PROVIDERS, ReviewInput, VIDEO_MAX_BYTES, VOICE_PRESETS, VOICE_TONES, type ProgressEvent } from '@corte/shared'
import { z } from 'zod'
import { activeProviders, preferProvider } from '@corte/providers'
import { requireAuth } from './auth.js'
import { getSettings } from './settings.js'

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
      if (settings.daily_video_limit > 0) {
        const today = await prisma.project.count({ where: { ownerId: req.user!.id, createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } })
        if (today >= settings.daily_video_limit) throw httpError(429, `Limite de ${settings.daily_video_limit} vídeos por dia atingido`)
      }
      const video = files.filter((f) => f.field === 'video')
      const images = files.filter((f) => f.field === 'images')
      if (video.length > 1) throw httpError(400, 'Envie só um vídeo de referência')
      if (video.length && input.link) throw httpError(400, 'Use link ou vídeo de referência, não os dois')
      // Estilo de uma análise pronta: a referência já vem analisada; pula baixar e analisar e vai direto ao roteiro.
      const analysis = input.analysisId ? await prisma.videoAnalysis.findFirst({ where: { id: input.analysisId, ownerId: req.user!.id, status: 'done' } }) : null
      if (input.analysisId && !analysis) throw httpError(400, 'Análise não encontrada ou ainda não terminou')
      if (analysis && (input.link || video.length)) throw httpError(400, 'Use a análise ou outra referência, não as duas')

      const project = await prisma.project.create({
        data: {
          ownerId: req.user!.id,
          name: input.name,
          prompt: input.prompt,
          targetDurationS: input.targetDurationS,
          options: optionsJson(input),
          reference: analysis
            ? { create: { sourceType: 'analysis', url: analysis.url, platform: analysis.platform, durationS: analysis.durationS, styleProfile: analysis.profile } }
            : input.link
            ? { create: { sourceType: 'link', url: input.link, platform: detectPlatform(input.link) } }
            : video[0] ? { create: { sourceType: 'upload', filePath: video[0].path } } : undefined,
          assets: {
            create: images.map((f, i) => ({
              kind: 'user_image', filePath: f.path, mime: f.mime, sortOrder: i, userCaption: input.captions[i] || null,
            })),
          },
          ...(analysis && { status: 'scripting' }),
          jobs: { create: analysis ? { type: 'script', stage: 'Na fila' } : { type: 'ingest', stage: 'Na fila' } },
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
      const order = RegenOrder.parse(JSON.parse(fields.order ?? '[]'))
      if (order.filter((o) => 'new' in o).length !== files.length) throw httpError(400, 'Imagens fora de ordem; tente de novo')
      const owned = new Set(p.assets.map((a) => a.id))
      if (order.some((o) => 'id' in o && !owned.has(o.id))) throw httpError(400, 'Imagem que não é deste vídeo')

      const kept = new Set(order.flatMap((o) => ('id' in o ? [o.id] : [])))
      const dropped = p.assets.filter((a) => !kept.has(a.id))
      // Refaz só o que mudou: roteiro (texto, duração, imagens, estilo de edição) → imagens → voz → vídeo.
      // Só a voz mudou: narra de novo e monta. Só a cor de fundo: só monta. Nada de analisar a referência de novo.
      const prev = JSON.parse(p.options) as Record<string, unknown>
      const next = JSON.parse(optionsJson(input, prev)) as Record<string, unknown>
      const sameImages = !files.length && !dropped.length && order.every((o, i) => 'id' in o && p.assets.find((a) => a.id === o.id)?.sortOrder === i && (p.assets.find((a) => a.id === o.id)?.userCaption ?? '') === (o.caption ?? ''))
      const changed = (k: string) => (prev[k] ?? null) !== (next[k] ?? null)
      const step = input.prompt !== p.prompt || input.targetDurationS !== p.targetDurationS || !sameImages || changed('editStyle') ? 'script'
        : changed('useStock') ? 'media'
        : changed('voicePreset') || changed('voiceTone') || changed('voiceBrief') ? 'voice'
        : 'render'
      const STATUS = { script: 'scripting', media: 'media', voice: 'media', render: 'rendering' } as const
      let n = 0
      await prisma.$transaction([
        prisma.scene.updateMany({ where: { assetId: { in: dropped.map((a) => a.id) } }, data: { assetId: null } }),
        prisma.asset.deleteMany({ where: { id: { in: dropped.map((a) => a.id) } } }),
        ...order.map((o, i) => ('id' in o
          ? prisma.asset.update({ where: { id: o.id }, data: { sortOrder: i, userCaption: o.caption || null } })
          : prisma.asset.create({ data: { projectId: p.id, kind: 'user_image', filePath: files[n++].path, mime: files[n - 1].mime, sortOrder: i, userCaption: o.caption || null } }))),
        // Fala nova = tempos novos: a legenda é refeita (com o mesmo estilo). Só remontar: a legenda fica como está.
        ...(step === 'render' ? [] : [prisma.captionTrack.updateMany({ where: { projectId: p.id }, data: { isCurrent: false } })]),
        prisma.project.update({ where: { id: p.id }, data: { name: input.name, prompt: input.prompt, targetDurationS: input.targetDurationS, status: STATUS[step], options: JSON.stringify(next) } }),
        prisma.job.create({ data: { projectId: p.id, type: step, stage: 'Na fila' } }),
      ])
      await Promise.all(dropped.map((a) => rm(a.filePath, { force: true })))
      return reply.code(202).send({ id: p.id, redo: step })
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
        videoVersions: { orderBy: { version: 'desc' }, select: { version: true, durationS: true, isCurrent: true, favorite: true } },
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
    // ?fromVersion=N: os campos com que aquela versão foi feita (para recriar a partir dela, não da última).
    const from = Number((req.query as { fromVersion?: string }).fromVersion) || null
    const src = from ? (JSON.parse((await prisma.videoVersion.findFirst({ where: { projectId: p.id, version: from }, select: { renderSettings: true } }))?.renderSettings ?? '{}').source as { name: string; prompt: string; targetDurationS: number; options: Record<string, unknown> } | undefined) : undefined
    return {
      ...rest,
      ...(src && { name: src.name, prompt: src.prompt, targetDurationS: src.targetDurationS }),
      fromVersion: src ? from : null,
      options: src ? { ...JSON.parse(p.options), ...src.options } : JSON.parse(p.options),
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
    // ?base=1: vídeo sem a legenda da fala (a prévia da aba Legendas desenha a legenda por cima).
    // ?clean=1: sem nada escrito (o editor desenha legenda e enunciados por cima). ?base=1: sem a legenda da fala.
    const q = req.query as { base?: string; clean?: string }, rs = JSON.parse(v.renderSettings) as { base?: string; clean?: string }
    const file = (q.clean ? rs.clean : q.base ? rs.base : undefined) ?? v.filePath
    const size = (await stat(file)).size
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
    const start = m?.[1] ? Number(m[1]) : 0
    const end = m?.[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start > end) return reply.code(416).header('content-range', `bytes */${size}`).send()
    reply.header('accept-ranges', 'bytes').header('content-type', 'video/mp4').header('content-length', end - start + 1)
    if (m) reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`)
    if ((req.query as { download?: string }).download) reply.header('content-disposition', `attachment; filename="video-v${v.version}.mp4"`)
    return reply.send(createReadStream(file, { start, end }))
  })

  // Voz que vai narrar os vídeos deste usuário (a primeira pronta) e as opções prontas para escolher em Novo vídeo.
  // Todas as vozes prontas para este usuário, com a origem: "Faber - Masculina (Piper)". O id é "fornecedor:voz".
  app.get('/api/voices', { preHandler: requireAuth }, async (req) => {
    const active = preferProvider(await activeProviders('voz', req.user!.id)) // Piper e macOS por último (erram mais a pronúncia)
    const voices = active.flatMap((a) => {
      const label = (PROVIDERS.find((x) => x.provider === a.provider)?.label ?? a.provider).split(' · ')[0].split(' (')[0]
      return (VOICE_PRESETS[a.provider] ?? []).map((v) => ({ id: `${a.provider}:${v.id}`, label: `${v.label} (${label})`, provider: a.provider }))
    })
    // Vozes próprias publicadas na aba Vozes vêm primeiro.
    const own = (await prisma.studioVoice.findMany({ where: { ownerId: req.user!.id, status: 'published' }, orderBy: { name: 'asc' } }))
      .map((v) => ({ id: `studio:${v.id}`, label: `${v.name} (Minha voz)`, provider: 'studio' }))
    voices.unshift(...own)
    const first = active[0]
    const current = first && `${first.provider}:${first.config.voice ?? ''}`
    return { voices, current: voices.some((v) => v.id === current) ? current : voices[0]?.id ?? null, tones: VOICE_TONES }
  })


  // ---------- Aprovação das imagens (antes da narração) ----------
  const BANK: Record<string, string> = { pixabay: 'Pixabay', openverse: 'Openverse', serper: 'Google Imagens', web: 'Web', wikimedia: 'Wikimedia Commons' }
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

  // ---------- Aprovação do roteiro ----------
  // approve: segue para as imagens. redo: o Claude reescreve com as dicas. scenes: fala e texto da tela editados à mão (salva antes de aprovar).
  app.post<{ Params: { id: string } }>('/api/projects/:id/script-review', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true, status: true, scripts: { orderBy: { version: 'desc' }, take: 1, select: { id: true } } } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (p.status !== 'script_review') return reply.code(409).send({ error: 'Este vídeo não está esperando a aprovação do roteiro' })
    const input = ScriptReviewInput.parse(req.body)
    if (input.scenes?.length) {
      await prisma.$transaction(input.scenes.map((s) => prisma.scene.updateMany({ where: { scriptId: p.scripts[0]?.id ?? '', index: s.index }, data: { narration: s.narration, onScreenText: s.onScreenText || null } })))
    }
    if (input.action === 'save') return { ok: true }
    const ok = input.action === 'approve'
      ? await advance(p.id, 'script_review', { status: 'media' }, 'media')
      : await advance(p.id, 'script_review', { status: 'scripting' }, 'script', undefined, JSON.stringify({ hint: input.hint }))
    if (!ok) return reply.code(409).send({ error: 'Este vídeo não está esperando a aprovação do roteiro' })
    return reply.code(202).send({ next: input.action === 'approve' ? 'imagens' : 'novo_roteiro' })
  })

  app.get<{ Params: { id: string } }>('/api/projects/:id/review', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true, status: true, scripts: { orderBy: { version: 'desc' }, take: 1, select: { id: true } } } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const scenes = await prisma.scene.findMany({
      where: { scriptId: p.scripts[0]?.id ?? '', asset: { kind: { in: ['stock_image', 'stock_video'] } } }, orderBy: { index: 'asc' },
      select: { index: true, narration: true, searchQuery: true, asset: { select: { id: true, kind: true, sourceProvider: true, attribution: true, license: true } } },
    })
    return {
      status: p.status,
      // 2ª rodada em diante (alguma cena já foi recusada): dá para enviar a própria foto no lugar.
      round: 1 + Math.max(0, ...scenes.filter((s) => !approvedScene(s.searchQuery)).map((s) => (s.searchQuery ? (JSON.parse(s.searchQuery) as { rejected?: string[] }).rejected?.length ?? 0 : 0))),
      // Só as que ainda não foram aprovadas: as aprovadas numa rodada anterior já esperam pela narração.
      scenes: scenes.filter((s) => !approvedScene(s.searchQuery)).map((s) => ({ index: s.index, narration: s.narration, assetId: s.asset!.id, kind: s.asset!.kind === 'stock_video' ? 'video' : 'image', bank: BANK[s.asset!.sourceProvider ?? ''] ?? s.asset!.sourceProvider, credit: s.asset!.attribution, copyright: /não verificad|sem licença/i.test(s.asset!.license ?? '') })),
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
    // As que estavam nesta rodada e não foram recusadas ficam aprovadas de vez.
    const pending = (await prisma.scene.findMany({ where: { scriptId: p.scripts[0]?.id ?? '', asset: { kind: { in: ['stock_image', 'stock_video'] } } }, select: { id: true, index: true, searchQuery: true } }))
      .filter((s) => !approvedScene(s.searchQuery) && !rejected.includes(s.index))
    const ok = await advance(p.id, 'image_review', { status: 'media' }, scenes.length ? 'media' : 'voice', (tx) => Promise.all([
      ...scenes.filter((s) => s.asset && s.searchQuery).map((s) => {
        const q = JSON.parse(s.searchQuery!)
        return tx.scene.update({ where: { id: s.id }, data: { assetId: null, searchQuery: JSON.stringify({ ...q, rejected: [...(q.rejected ?? []), `${s.asset!.sourceProvider}:${s.asset!.sourceId}`] }) } })
      }),
      ...pending.map((s) => tx.scene.update({ where: { id: s.id }, data: { searchQuery: JSON.stringify({ ...(s.searchQuery ? JSON.parse(s.searchQuery) : {}), approved: true }) } })),
    ]))
    if (!ok) return reply.code(409).send({ error: 'Este vídeo não está esperando aprovação de imagens' })
    return reply.code(202).send({ next: scenes.length ? 'nova_busca' : 'narracao', replaced: scenes.length })
  })

  // Na aprovação: troca a imagem de uma cena por uma foto enviada pela pessoa. Ela já fica aprovada.
  app.post<{ Params: { id: string; index: string } }>('/api/projects/:id/review/:index/upload', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true, status: true, scripts: { orderBy: { version: 'desc' }, take: 1, select: { id: true } } } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (p.status !== 'image_review') return reply.code(409).send({ error: 'Este vídeo não está esperando aprovação de imagens' })
    const scene = await prisma.scene.findFirst({ where: { scriptId: p.scripts[0]?.id ?? '', index: Number(req.params.index) } })
    if (!scene) return reply.code(404).send({ error: 'Cena não encontrada' })
    const part = await req.file()
    if (!part || part.fieldname !== 'images') return reply.code(400).send({ error: 'Envie a foto' })
    const saved = await saveUpload(part) // mesma checagem de tipo real e tamanho das outras imagens
    const asset = await prisma.asset.create({ data: { projectId: p.id, kind: 'review_image', filePath: saved.path, mime: saved.mime, sortOrder: scene.index } })
    await prisma.scene.update({ where: { id: scene.id }, data: { assetId: asset.id, searchQuery: JSON.stringify({ ...(scene.searchQuery ? JSON.parse(scene.searchQuery) : {}), approved: true }) } })
    return reply.code(201).send({ ok: true })
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

  // Tempo de cada etapa da criação e a estimativa total (sem contar o tempo esperando a sua aprovação das imagens).
  app.get<{ Params: { id: string } }>('/api/projects/:id/timing', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true, targetDurationS: true, options: true, jobs: { orderBy: { createdAt: 'asc' }, select: { type: true, status: true, startedAt: true, finishedAt: true } } } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    // A criação atual começa na última ingestão ou no último roteiro novo (nova versão).
    const jobs = p.jobs.filter((j) => j.type !== 'cuts' && j.type !== 'regen_part')
    let start = 0
    // Nova versão começa em qualquer etapa (roteiro, imagens, voz ou vídeo) logo depois de um vídeo pronto.
    jobs.forEach((j, i) => { if (j.type === 'ingest' || (i > 0 && jobs[i - 1].type === 'render' && jobs[i - 1].status === 'done')) start = i })
    const run = jobs.slice(start)
    const ownVoice = String(JSON.parse(p.options).voicePreset ?? '').startsWith('studio:')
    const now = Date.now()
    const from = Math.max(0, PIPELINE.indexOf((run[0]?.type ?? 'ingest') as (typeof PIPELINE)[number]))
    const stages = await Promise.all(PIPELINE.slice(from).map(async (type) => {
      const done = run.filter((j) => j.type === type)
      const elapsedS = done.reduce((n, j) => n + (j.startedAt ? ((j.finishedAt?.getTime() ?? now) - j.startedAt.getTime()) / 1000 : 0), 0)
      const last = done.at(-1)
      return { type, status: last?.status ?? 'pending', elapsedS: Math.round(elapsedS), estimateS: await stageEstimate(type, p.targetDurationS, ownVoice) }
    }))
    return { stages, elapsedS: stages.reduce((n, s) => n + s.elapsedS, 0), estimateS: stages.reduce((n, s) => n + s.estimateS, 0) }
  })

  // "Parar a criação": a etapa em andamento termina e nada mais segue; o vídeo fica como "Falhou" (dá para tentar de novo).
  app.post<{ Params: { id: string } }>('/api/projects/:id/cancel', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    await prisma.$transaction([
      prisma.job.updateMany({ where: { projectId: p.id, status: { in: ['queued', 'paused'] } }, data: { status: 'failed', error: CANCELED, finishedAt: new Date() } }),
      prisma.job.updateMany({ where: { projectId: p.id, status: 'running' }, data: { error: CANCELED } }), // o worker vê e para ao fim da etapa
      prisma.project.update({ where: { id: p.id }, data: { status: 'failed' } }),
    ])
    return { ok: true }
  })

  // Tentativa que falhou: volta para a última versão pronta do vídeo (se houver).
  app.post<{ Params: { id: string } }>('/api/projects/:id/discard', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true, status: true, _count: { select: { videoVersions: true } } } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (p.status !== 'failed') return reply.code(409).send({ error: 'Só dá para descartar uma tentativa que falhou' })
    if (!p._count.videoVersions) return reply.code(409).send({ error: 'Este vídeo ainda não tem versão pronta; use Excluir' })
    await prisma.project.update({ where: { id: p.id }, data: { status: 'editing' } })
    return { ok: true }
  })

  // Favoritar uma versão.
  app.patch<{ Params: { id: string; v: string } }>('/api/projects/:id/versions/:v', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const { favorite } = z.object({ favorite: z.boolean() }).parse(req.body)
    const { count } = await prisma.videoVersion.updateMany({ where: { projectId: p.id, version: Number(req.params.v) }, data: { favorite } })
    return count ? { favorite } : reply.code(404).send({ error: 'Versão não encontrada' })
  })

  // Excluir uma versão sem apagar o projeto. A última que sobra não sai (aí é excluir o projeto).
  app.delete<{ Params: { id: string; v: string } }>('/api/projects/:id/versions/:v', { preHandler: requireAuth }, async (req, reply) => {
    const p = await prisma.project.findFirst({ where: projectScope(req, req.params.id), select: { id: true, status: true, videoVersions: { orderBy: { version: 'desc' } } } })
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const v = p.videoVersions.find((x) => x.version === Number(req.params.v))
    if (!v) return reply.code(404).send({ error: 'Versão não encontrada' })
    if (p.videoVersions.length === 1) return reply.code(409).send({ error: 'É a única versão. Para apagar, exclua o projeto.' })
    if (await prisma.job.findFirst({ where: { projectId: p.id, status: { in: ['queued', 'running', 'paused'] } } })) return reply.code(409).send({ error: 'Espere a tarefa em andamento terminar' })
    const others = p.videoVersions.filter((x) => x.id !== v.id)
    await prisma.$transaction([
      prisma.videoVersion.delete({ where: { id: v.id } }),
      ...(v.isCurrent ? [prisma.videoVersion.update({ where: { id: others[0].id }, data: { isCurrent: true } })] : []),
    ])
    // Arquivos desta versão; o vídeo base e o limpo podem ser compartilhados com outra versão (troca rápida de legenda).
    const used = new Set(others.flatMap((o) => { const r = JSON.parse(o.renderSettings) as { base?: string; clean?: string }; return [o.filePath, r.base, r.clean] }))
    const rs = JSON.parse(v.renderSettings) as { base?: string; clean?: string }
    await Promise.all([v.filePath, rs.base, rs.clean].filter((f): f is string => !!f && !used.has(f)).map((f) => rm(f, { force: true })))
    return { ok: true, current: v.isCurrent ? others[0].version : others.find((o) => o.isCurrent)?.version }
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
    ...prev, voiceBrief: input.voiceBrief, voicePreset: input.voicePreset, voiceTone: input.voiceTone,
    bgColor: input.bgColor, useStock: input.useStock, editStyle: input.editStyle,
  })
}

const RegenOrder = z.array(z.union([z.object({ id: z.string().uuid(), caption: z.string().max(200).default('') }), z.object({ new: z.literal(true), caption: z.string().max(200).default('') })])).max(200)

export const CANCELED = 'Parado por você'
const PIPELINE = ['ingest', 'analyze', 'script', 'media', 'voice', 'render'] as const
// Estimativa de cada etapa: o histórico real desta máquina, mas nunca menos que a conta conservadora
// (segundos fixos + segundos por minuto de vídeo). Vídeo longo demora mais, e a estimativa diz isso.
const BASE: Record<string, [number, number]> = { ingest: [30, 15], analyze: [90, 40], script: [120, 60], media: [90, 75], voice: [40, 70], render: [60, 100] }
async function stageEstimate(type: string, durationS: number, ownVoice: boolean) {
  const [fixed, perMin] = type === 'voice' && ownVoice ? [60, 200] : BASE[type]
  const floor = fixed + perMin * (durationS / 60)
  const history = await estimateSeconds(type, durationS)
  return Math.round(Math.max(floor * 0.8, history ?? floor))
}

// Imagem já aprovada numa rodada anterior da aprovação (fica guardada na busca da cena).
export const approvedScene = (searchQuery: string | null) => !!searchQuery && (JSON.parse(searchQuery) as { approved?: boolean }).approved === true

const ScriptReviewInput = z.object({
  action: z.enum(['approve', 'redo', 'save']),
  hint: z.string().trim().max(2000).optional(),
  scenes: z.array(z.object({ index: z.number().int().min(0), narration: z.string().trim().max(2000), onScreenText: z.string().trim().max(120).default('') })).max(500).optional(),
}).refine((v) => v.action !== 'redo' || !!v.hint, { message: 'Diga como quer o roteiro novo', path: ['hint'] })
