import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma, STORAGE_DIR } from '@corte/db'
import { CaptionTrackInput, ChangeRequestInput, MetadataInput, MetaField, MUSIC_STYLES, RegenInput, RestoreInput } from '@corte/shared'
import { requireAuth } from './auth.js'
import { enabledFonts } from './settings.js'
import { z } from 'zod'

const run = promisify(execFile)
const FFMPEG = process.env.FFMPEG_PATH ?? (existsSync('/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg') ? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg' : 'ffmpeg')
type Req = FastifyRequest<{ Params: { id: string; field?: string } }>

// Mesmo escopo das outras rotas: usuário comum só os próprios projetos (o resto vira 404).
async function project(req: Req) {
  const where = req.user!.role === 'admin' ? { id: req.params.id } : { id: req.params.id, ownerId: req.user!.id }
  return prisma.project.findFirst({ where, select: { id: true, name: true, status: true, options: true } })
}
const EDITABLE = ['editing', 'in_approval', 'failed']

// Um job de criação por vez por projeto.
async function busy(projectId: string) {
  return !!(await prisma.job.findFirst({ where: { projectId, status: { in: ['queued', 'running', 'paused'] } } }))
}

async function newMetadataVersion(projectId: string, field: string, value: string, createdBy: string) {
  return prisma.$transaction(async (tx) => {
    const last = await tx.metadataField.aggregate({ where: { projectId, field }, _max: { version: true } })
    await tx.metadataField.updateMany({ where: { projectId, field }, data: { isCurrent: false } })
    return tx.metadataField.create({ data: { projectId, field, value, version: (last._max.version ?? 0) + 1, createdBy } })
  })
}

// Anota o que mudou (em português, com antes → depois). O próximo render grava a lista na versão nova (aba Versões).
async function noteChanges(projectId: string, notes: string[]) {
  if (!notes.length) return
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { options: true } })
  const o = JSON.parse(p.options) as { pendingChanges?: string[] }
  await prisma.project.update({ where: { id: projectId }, data: { options: JSON.stringify({ ...o, pendingChanges: [...(o.pendingChanges ?? []), ...notes].slice(-200) }) } })
}
const LABELS: Record<string, Record<string, string>> = {
  motion: { ken_burns: 'Ken Burns', parallax: 'Parallax 2.5D', cutout: 'Recorte de revista', snap_zoom: 'Zoom rápido', static: 'Parada' },
  easing: { ease_in_out: 'suave nas pontas', ease_in: 'começa lento', ease_out: 'termina lento', linear: 'constante' },
  transition: { cut: 'corte seco', fade: 'dissolver', zoom_through: 'zoom através', slide_left: 'deslizar ←', slide_right: 'deslizar →', slide_up: 'deslizar ↑', slide_down: 'deslizar ↓', whip: 'chicote', punch_in: 'soco de zoom' },
}
const fmtS = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`
const say = (k: string, v: unknown) => (v == null || v === '' ? 'nada' : LABELS[k]?.[String(v)] ?? String(v))

export async function editRoutes(app: FastifyInstance) {
  const guard = { preHandler: requireAuth }

  // Tudo que a tela de Edição precisa, sem caminhos de arquivo.
  app.get<{ Params: { id: string } }>('/api/projects/:id/edit', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const [videos, tracks, meta, requests, job, script, audio] = await Promise.all([
      prisma.videoVersion.findMany({ where: { projectId: p.id }, orderBy: { version: 'desc' }, select: { version: true, durationS: true, isCurrent: true, createdAt: true, renderSettings: true } }),
      prisma.captionTrack.findMany({
        where: { projectId: p.id }, orderBy: { version: 'desc' },
        include: { segments: { orderBy: { startS: 'asc' }, select: { startS: true, endS: true, text: true, highlights: true } } },
      }),
      prisma.metadataField.findMany({ where: { projectId: p.id }, orderBy: { version: 'desc' }, select: { field: true, version: true, value: true, isCurrent: true, createdBy: true, createdAt: true } }),
      prisma.changeRequest.findMany({ where: { projectId: p.id }, orderBy: { createdAt: 'desc' }, include: { author: { select: { name: true } } } }),
      prisma.job.findFirst({ where: { projectId: p.id, status: { in: ['queued', 'running', 'paused'] } }, select: { type: true, status: true, stage: true, progress: true } }),
      prisma.script.findFirst({ where: { projectId: p.id }, orderBy: { version: 'desc' }, select: { scenes: { orderBy: { index: 'asc' }, select: { index: true, startS: true, endS: true, narration: true, onScreenText: true, motion: true, easing: true, transition: true, assetId: true, searchQuery: true, asset: { select: { kind: true } } } } } }),
      prisma.asset.findMany({ where: { projectId: p.id, kind: { in: ['voice', 'music'] } }, select: { id: true, kind: true, sortOrder: true, attribution: true } }),
    ])
    const current = tracks.find((t) => t.isCurrent) ?? null
    return {
      name: p.name, status: p.status, job, captionsOn: JSON.parse(p.options).captionsOn === true,
      // Camadas do editor: cada cena com enunciado, movimento, transição e a narração dela; trilha e opções gerais.
      scenes: (script?.scenes ?? []).map(({ asset, assetId: _a, searchQuery, ...s }) => ({ ...s, onScreenText: s.onScreenText ?? (!asset && searchQuery ? (JSON.parse(searchQuery) as { text?: string }).text ?? null : null), kind: !asset ? 'card' : asset.kind.endsWith('video') ? 'video' : 'image', voiceId: audio.find((a) => a.kind === 'voice' && a.sortOrder === s.index)?.id ?? null })),
      music: audio.find((a) => a.kind === 'music') ?? null,
      options: (({ musicVolume = 35, sfxVolume = 55, titleStyle = null, bgColor = '#111418', musicStyle = 'none', voicePreset = '', voiceTone = 'natural' }) => ({ musicVolume, sfxVolume, titleStyle, bgColor, musicStyle, voicePreset, voiceTone }))(JSON.parse(p.options)),
      videos: videos.map(({ renderSettings, ...v }) => ({ ...v, changes: (JSON.parse(renderSettings).changes ?? null) as string[] | null })),
      caption: current && { ...current, segments: current.segments.map((s) => ({ ...s, highlights: JSON.parse(s.highlights) })) },
      captionVersions: tracks.map((t) => ({ version: t.version, isCurrent: t.isCurrent, createdAt: t.createdAt, fontFamily: t.fontFamily, segments: t.segments.length })),
      metadata: meta,
      changeRequests: requests.map((r) => ({ id: r.id, part: r.part, frameTimeS: r.frameTimeS, type: r.type, text: r.text, status: r.status, author: r.author.name, appliedInVersion: r.appliedInVersion, createdAt: r.createdAt })),
    }
  })

  // Quadro do vídeo atual num instante (miniaturas da timeline). Gerado uma vez e guardado.
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>('/api/projects/:id/frame', guard, async (req, reply) => {
    const p = await project(req)
    const v = p && await prisma.videoVersion.findFirst({ where: { projectId: p.id, isCurrent: true } })
    if (!v) return reply.code(404).send({ error: 'Vídeo não encontrado' })
    const t = Math.max(0, Math.min(Number(req.query.t) || 0, v.durationS - 0.05))
    const dir = join(STORAGE_DIR, 'thumbs', p!.id, `v${v.version}`)
    const file = join(dir, `${t.toFixed(1)}.jpg`)
    if (!existsSync(file)) {
      await mkdir(dir, { recursive: true })
      await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', t.toFixed(2), '-i', v.filePath, '-frames:v', '1', '-vf', 'scale=320:-2', file])
    }
    const { createReadStream } = await import('node:fs')
    return reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=86400').send(createReadStream(file))
  })

  // ---------- Título, descrição, palavras-chave ----------
  app.put<{ Params: { id: string; field: string } }>('/api/projects/:id/metadata/:field', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const field = MetaField.parse(req.params.field)
    const { value } = MetadataInput.parse(req.body)
    const row = await newMetadataVersion(p.id, field, value, req.user!.id)
    return { version: row.version }
  })

  app.post<{ Params: { id: string; field: string } }>('/api/projects/:id/metadata/:field/restore', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const field = MetaField.parse(req.params.field)
    const { version } = RestoreInput.parse(req.body)
    const old = await prisma.metadataField.findFirst({ where: { projectId: p.id, field, version } })
    if (!old) return reply.code(404).send({ error: 'Versão não encontrada' })
    // Voltar atrás cria uma versão nova com o conteúdo antigo: nada se perde.
    const row = await newMetadataVersion(p.id, field, old.value, req.user!.id)
    return { version: row.version }
  })

  // ---------- Legenda ----------
  app.put<{ Params: { id: string } }>('/api/projects/:id/captions', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const input = CaptionTrackInput.parse(req.body)
    if (!(await enabledFonts()).includes(input.fontFamily)) return reply.code(400).send({ error: 'Fonte não liberada pelo admin' })
    const video = await prisma.videoVersion.findFirst({ where: { projectId: p.id, isCurrent: true } })
    if (video && input.segments.some((s) => s.endS > video.durationS + 0.5)) return reply.code(400).send({ error: 'Há legenda depois do fim do vídeo' })
    const { segments, ...style } = input
    const prev = await prisma.captionTrack.findFirst({ where: { projectId: p.id, isCurrent: true }, include: { segments: { orderBy: { startS: 'asc' } } } })
    if (prev) {
      const notes: string[] = []
      const NAMES: Record<string, string> = { fontFamily: 'fonte', fontWeight: 'peso', size: 'tamanho', color: 'cor', highlightColor: 'cor do destaque', highlightMode: 'modo de destaque', position: 'posição', outline: 'traçado' }
      for (const [k, v] of Object.entries(style)) if (String(prev[k as keyof typeof prev]) !== String(v)) notes.push(`Legenda · ${NAMES[k] ?? k}: ${String(prev[k as keyof typeof prev])} → ${String(v)}`)
      const was = new Map(prev.segments.map((g) => [g.startS.toFixed(1), g]))
      const now = [...segments].sort((a, b) => a.startS - b.startS)
      for (const g of now) {
        const o = was.get(g.startS.toFixed(1))
        if (!o) notes.push(`Legenda · nova linha em ${fmtS(g.startS)}: "${g.text}"`)
        else if (o.text !== g.text) notes.push(`Legenda · ${fmtS(g.startS)}: "${o.text}" → "${g.text}"`)
        else if (Math.abs(o.endS - g.endS) > 0.05) notes.push(`Legenda · ${fmtS(g.startS)}: fim ${fmtS(o.endS)} → ${fmtS(g.endS)}`)
        else if (o.highlights !== JSON.stringify(g.highlights)) notes.push(`Legenda · ${fmtS(g.startS)}: destaque de palavras em "${g.text}"`)
      }
      const kept = new Set(now.map((g) => g.startS.toFixed(1)))
      for (const o of prev.segments) if (!kept.has(o.startS.toFixed(1))) notes.push(`Legenda · apagada a linha de ${fmtS(o.startS)}: "${o.text}"`)
      await noteChanges(p.id, notes)
    }
    const track = await prisma.$transaction(async (tx) => {
      const last = await tx.captionTrack.aggregate({ where: { projectId: p.id }, _max: { version: true } })
      await tx.captionTrack.updateMany({ where: { projectId: p.id }, data: { isCurrent: false } })
      return tx.captionTrack.create({
        data: {
          projectId: p.id, version: (last._max.version ?? 0) + 1, ...style,
          segments: { create: [...segments].sort((a, b) => a.startS - b.startS).map((s) => ({ ...s, highlights: JSON.stringify(s.highlights) })) },
        },
      })
    })
    return { version: track.version }
  })

  app.post<{ Params: { id: string } }>('/api/projects/:id/captions/restore', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const { version } = RestoreInput.parse(req.body)
    const old = await prisma.captionTrack.findFirst({ where: { projectId: p.id, version }, include: { segments: true } })
    if (!old) return reply.code(404).send({ error: 'Versão não encontrada' })
    const { id: _id, segments, version: _v, createdAt: _c, updatedAt: _u, isCurrent: _i, ...style } = old
    const track = await prisma.$transaction(async (tx) => {
      const last = await tx.captionTrack.aggregate({ where: { projectId: p.id }, _max: { version: true } })
      await tx.captionTrack.updateMany({ where: { projectId: p.id }, data: { isCurrent: false } })
      return tx.captionTrack.create({
        data: { ...style, version: (last._max.version ?? 0) + 1, segments: { create: segments.map(({ startS, endS, text, highlights }) => ({ startS, endS, text, highlights })) } },
      })
    })
    return { version: track.version }
  })

  // ---------- Vídeo ----------
  app.post<{ Params: { id: string } }>('/api/projects/:id/video/restore', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const { version } = RestoreInput.parse(req.body)
    const v = await prisma.videoVersion.findFirst({ where: { projectId: p.id, version } })
    if (!v) return reply.code(404).send({ error: 'Versão não encontrada' })
    await prisma.$transaction([
      prisma.videoVersion.updateMany({ where: { projectId: p.id }, data: { isCurrent: false } }),
      prisma.videoVersion.update({ where: { id: v.id }, data: { isCurrent: true } }),
    ])
    return { version }
  })

  // Renderiza de novo com a legenda atual (depois de editar texto, tempo, fonte ou destaque).
  app.post<{ Params: { id: string } }>('/api/projects/:id/render', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (!EDITABLE.includes(p.status)) return reply.code(409).send({ error: 'O vídeo ainda está sendo criado' })
    if (await busy(p.id)) return reply.code(409).send({ error: 'Já existe uma tarefa em andamento neste projeto' })
    // titlesOnly: só enunciados mudaram; o worker escreve os títulos sobre o vídeo atual, sem montar tudo de novo.
    const titlesOnly = (req.body as { titlesOnly?: boolean } | null)?.titlesOnly === true
    await prisma.job.create({ data: { projectId: p.id, type: 'render', stage: 'Na fila', ...(titlesOnly && { payload: JSON.stringify({ titlesOnly }) }) } })
    await prisma.project.update({ where: { id: p.id }, data: { status: 'rendering' } })
    return reply.code(202).send({ ok: true })
  })

  // Aba Legendas: liga a legenda no vídeo e queima a trilha atual sobre o vídeo base (sem montar as cenas de novo).
  // on=false tira a legenda do vídeo.
  app.post<{ Params: { id: string } }>('/api/projects/:id/captions/apply', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (!EDITABLE.includes(p.status)) return reply.code(409).send({ error: 'O vídeo ainda está sendo criado' })
    if (await busy(p.id)) return reply.code(409).send({ error: 'Já existe uma tarefa em andamento neste projeto' })
    const on = (req.body as { on?: boolean } | null)?.on !== false
    if (on !== (JSON.parse(p.options).captionsOn === true)) await noteChanges(p.id, [on ? 'Legenda ligada no vídeo' : 'Legenda tirada do vídeo'])
    await prisma.$transaction([
      // Lê de novo: a anotação acima já mudou as opções.
      prisma.project.update({ where: { id: p.id }, data: { status: 'rendering', options: JSON.stringify({ ...JSON.parse((await prisma.project.findUniqueOrThrow({ where: { id: p.id }, select: { options: true } })).options), captionsOn: on }) } }),
      prisma.job.create({ data: { projectId: p.id, type: 'render', stage: 'Na fila', payload: JSON.stringify({ captionsOnly: true }) } }),
    ])
    return reply.code(202).send({ captionsOn: on })
  })

  // Editor: muda uma cena (enunciado, movimento, curva, transição). Vale no próximo "Renderizar".
  app.patch<{ Params: { id: string; index: string } }>('/api/projects/:id/scenes/:index', guard, async (req, reply) => {
    const p = await project(req as unknown as Req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const data = ScenePatch.parse(req.body)
    const script = await prisma.script.findFirst({ where: { projectId: p.id }, orderBy: { version: 'desc' }, select: { id: true } })
    const where = { scriptId: script?.id ?? '', index: Number(req.params.index) }
    const before = await prisma.scene.findFirst({ where })
    if (!before) return reply.code(404).send({ error: 'Cena não encontrada' })
    const { durationS, ...fields } = data
    if (durationS !== undefined && before.narration?.trim()) return reply.code(400).send({ error: 'Cena com narração dura o tempo da fala; só cartelas e cenas sem fala mudam de duração' })
    await prisma.scene.updateMany({ where, data: fields })
    if (durationS !== undefined) {
      const delta = Math.round((durationS - (before.endS - before.startS)) * 100) / 100
      if (delta) {
        const cut = before.endS - 0.01
        const track = await prisma.captionTrack.findFirst({ where: { projectId: p.id, isCurrent: true }, select: { id: true } })
        await prisma.$transaction([
          prisma.scene.update({ where: { id: before.id }, data: { endS: before.endS + delta } }),
          prisma.scene.updateMany({ where: { scriptId: before.scriptId, index: { gt: before.index } }, data: { startS: { increment: delta }, endS: { increment: delta } } }),
          ...(track ? [prisma.captionSegment.updateMany({ where: { trackId: track.id, startS: { gte: cut } }, data: { startS: { increment: delta }, endS: { increment: delta } } })] : []),
        ])
        await noteChanges(p.id, [`Cena ${before.index + 1} · duração: ${(before.endS - before.startS).toFixed(1)} s → ${durationS.toFixed(1)} s`])
      }
    }
    const n = Number(req.params.index) + 1, names = { onScreenText: 'enunciado', motion: 'motion', easing: 'curva do movimento', transition: 'transição' } as const
    await noteChanges(p.id, (Object.keys(fields) as (keyof typeof names)[]).filter((k) => data[k] !== undefined && (before[k] ?? null) !== (data[k] ?? null))
      .map((k) => k === 'onScreenText' ? `Cena ${n} · enunciado: "${before.onScreenText ?? ''}" → "${data.onScreenText ?? ''}"` : `Cena ${n} · ${names[k]}: ${say(k, before[k])} → ${say(k, data[k])}`))
    return { ok: true }
  })

  // Editor: opções gerais do vídeo (volume da trilha e dos efeitos, estilo dos enunciados, cor de fundo).
  app.patch<{ Params: { id: string } }>('/api/projects/:id/options', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const patch = OptionsPatch.parse(req.body)
    if (patch.titleStyle && !(await enabledFonts()).includes(patch.titleStyle.fontFamily)) return reply.code(400).send({ error: 'Fonte não liberada pelo admin' })
    const old = { musicVolume: 35, sfxVolume: 55, musicStyle: 'none', ...JSON.parse(p.options) } as Record<string, unknown>
    const ts = (t: unknown) => { const x = t as { fontFamily: string; size: number; color: string; bandColor: string } | null; return x ? `${x.fontFamily}, tamanho ${x.size}, texto ${x.color}, faixa ${x.bandColor}` : 'padrão' }
    const notes: string[] = []
    if (patch.musicStyle !== undefined && patch.musicStyle !== old.musicStyle) notes.push(`Trilha: ${MUSIC_STYLES.find((m) => m.id === old.musicStyle)?.label ?? 'nenhuma'} → ${MUSIC_STYLES.find((m) => m.id === patch.musicStyle)?.label}`)
    if (patch.musicVolume !== undefined && patch.musicVolume !== old.musicVolume) notes.push(`Volume da trilha: ${old.musicVolume}% → ${patch.musicVolume}%`)
    if (patch.sfxVolume !== undefined && patch.sfxVolume !== old.sfxVolume) notes.push(`Efeitos sonoros: ${old.sfxVolume}% → ${patch.sfxVolume}%`)
    if (patch.titleStyle && JSON.stringify(patch.titleStyle) !== JSON.stringify(old.titleStyle ?? null)) notes.push(`Estilo dos enunciados: ${ts(old.titleStyle)} → ${ts(patch.titleStyle)}`)
    if (patch.voicePreset && patch.voicePreset !== old.voicePreset) notes.push(`Voz da narração: ${old.voicePreset ?? 'padrão'} → ${patch.voicePreset}`)
    if (patch.voiceTone && patch.voiceTone !== old.voiceTone) notes.push(`Ritmo da narração: ${old.voiceTone ?? 'natural'} → ${patch.voiceTone}`)
    if (patch.bgColor && patch.bgColor !== old.bgColor) notes.push(`Cor do fundo: ${old.bgColor ?? 'padrão'} → ${patch.bgColor}`)
    // Estilo novo de trilha: o próximo render busca outra música.
    await prisma.project.update({ where: { id: p.id }, data: { options: JSON.stringify({ ...JSON.parse(p.options), ...patch, ...(patch.musicStyle && { musicPicked: null }) }) } })
    await noteChanges(p.id, notes)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/projects/:id/revoice', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (!EDITABLE.includes(p.status)) return reply.code(409).send({ error: 'O vídeo ainda está sendo criado' })
    if (await busy(p.id)) return reply.code(409).send({ error: 'Já existe uma tarefa em andamento neste projeto' })
    await prisma.$transaction([
      prisma.captionTrack.updateMany({ where: { projectId: p.id }, data: { isCurrent: false } }),
      prisma.project.update({ where: { id: p.id }, data: { status: 'media' } }),
      prisma.job.create({ data: { projectId: p.id, type: 'voice', stage: 'Na fila' } }),
    ])
    return reply.code(202).send({ ok: true })
  })

  // Duração padrão das cartelas nos próximos vídeos desta pessoa (opcional, ao aplicar a todas).
  app.put('/api/me/card-duration', guard, async (req) => {
    const { durationS } = z.object({ durationS: z.number().min(0.5).max(15).nullable() }).parse(req.body)
    const key = `card_duration:${req.user!.id}`
    if (durationS === null) await prisma.setting.deleteMany({ where: { key } })
    else await prisma.setting.upsert({ where: { key }, create: { key, value: String(durationS) }, update: { value: String(durationS) } })
    return { durationS }
  })
  app.get('/api/me/card-duration', guard, async (req) => {
    const row = await prisma.setting.findUnique({ where: { key: `card_duration:${req.user!.id}` } })
    return { durationS: row ? Number(row.value) : null }
  })

  // ---------- Pedidos de alteração e regerar uma parte ----------
  app.post<{ Params: { id: string } }>('/api/projects/:id/change-requests', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const input = ChangeRequestInput.parse(req.body)
    const cr = await prisma.changeRequest.create({ data: { ...input, projectId: p.id, authorId: req.user!.id } })
    return reply.code(201).send({ id: cr.id })
  })

  app.delete<{ Params: { id: string; crId: string } }>('/api/projects/:id/change-requests/:crId', guard, async (req, reply) => {
    const p = await project(req as unknown as Req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    const { count } = await prisma.changeRequest.deleteMany({ where: { id: req.params.crId, projectId: p.id, status: 'open' } })
    return count ? { ok: true } : reply.code(404).send({ error: 'Pedido não encontrado' })
  })

  app.post<{ Params: { id: string } }>('/api/projects/:id/regen', guard, async (req, reply) => {
    const p = await project(req)
    if (!p) return reply.code(404).send({ error: 'Projeto não encontrado' })
    if (!EDITABLE.includes(p.status)) return reply.code(409).send({ error: 'O vídeo ainda está sendo criado' })
    if (await busy(p.id)) return reply.code(409).send({ error: 'Já existe uma tarefa em andamento neste projeto' })
    const { part } = RegenInput.parse(req.body)
    if (part === 'video' && !(await prisma.changeRequest.count({ where: { projectId: p.id, part, status: 'open' } }))) {
      return reply.code(400).send({ error: 'Marque pelo menos um pedido de alteração no vídeo antes de regerar' })
    }
    await prisma.job.create({ data: { projectId: p.id, type: 'regen_part', stage: 'Na fila', payload: JSON.stringify({ part }) } })
    return reply.code(202).send({ ok: true })
  })
}

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/)
const ALIGN = /^(top|middle|bottom)-(left|center|right)$/
const ScenePatch = z.object({
  onScreenText: z.string().trim().max(120).nullable().optional().transform((v) => (v === '' ? null : v)),
  motion: z.enum(['ken_burns', 'parallax', 'cutout', 'snap_zoom', 'static']).optional(),
  easing: z.enum(['ease_in_out', 'ease_in', 'ease_out', 'linear']).optional(),
  transition: z.enum(['cut', 'punch_in', 'punch_out', 'fade', 'zoom_through', 'slide_left', 'slide_right', 'slide_up', 'slide_down', 'whip']).optional(),
  durationS: z.number().min(0.5).max(15).optional(),
}).strict()
const OptionsPatch = z.object({
  musicVolume: z.number().int().min(0).max(100).optional(),
  musicStyle: z.enum(MUSIC_STYLES.map((m) => m.id) as [string, ...string[]]).optional(),
  voicePreset: z.string().trim().min(1).max(60).optional(),
  voiceTone: z.enum(['calma', 'natural', 'animada']).optional(),
  sfxVolume: z.number().int().min(0).max(100).optional(),
  bgColor: hexColor.optional(),
  titleStyle: z.object({
    fontFamily: z.string().trim().min(1).max(60), size: z.number().int().min(60).max(260), color: hexColor, bandColor: hexColor,
    bandSize: z.number().int().min(24).max(140).optional(), cardAlign: z.string().regex(ALIGN).optional(), bandAlign: z.string().regex(ALIGN).optional(), upper: z.boolean().optional(),
  }).optional(),
}).strict()
