import { tmpdir } from 'node:os'
import { z } from 'zod'
import { prisma, type Job } from '@corte/db'
import { Scene, type Part } from '@corte/shared'
import { askClaude } from './claude.js'

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export const VideoChanges = z.object({
  changes: z.array(z.object({
    index: z.number().int().min(0),
    narration: z.string().optional(),
    onScreenText: z.string().optional(),
    media: Scene.shape.media.optional(),
    transition: Scene.shape.transition.optional(),
  })),
})

// Regera só uma parte do vídeo, aplicando os pedidos de alteração abertos dessa parte.
export async function regenPart(job: Job) {
  const { part } = JSON.parse(job.payload ?? '{}') as { part: Part }
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: job.projectId },
    include: {
      scripts: { orderBy: { version: 'desc' }, take: 1, include: { scenes: { orderBy: { index: 'asc' } } } },
      metadataFields: { where: { isCurrent: true } },
      changeRequests: { where: { part, status: 'open' }, orderBy: { createdAt: 'asc' } },
      captionTracks: { where: { isCurrent: true }, include: { segments: { orderBy: { startS: 'asc' } } } },
      assets: { where: { kind: 'user_image' }, orderBy: { sortOrder: 'asc' } },
    },
  })
  const script = project.scripts[0]
  const meta = Object.fromEntries(project.metadataFields.map((m) => [m.field, m.value]))
  const requests = project.changeRequests.map((c) => `- ${c.frameTimeS != null ? `[${fmt(c.frameTimeS)}] ` : ''}${c.text}`).join('\n')
  const context = `Pedido original do cliente:\n"""\n${project.prompt}\n"""\n\nRoteiro atual:\n"""\n${script?.body ?? ''}\n"""`
  await prisma.job.update({ where: { id: job.id }, data: { stage: `Claude regerando: ${part}`, progress: 20 } })
  let appliedIn: number | null = null

  if (part === 'title' || part === 'description' || part === 'keywords') {
    // Palavras-chave voltam como texto separado por vírgulas, no mesmo formato que a tela edita.
    const schema = z.object({ value: z.string().min(1).max(part === 'title' ? 100 : 5000) })
    const current = (meta[part] ?? '').split('\n\nCréditos:\n')[0]
    const out = await askClaude({
      jobId: job.id, cwd: tmpdir(), effort: 'medium', schema,
      prompt: [
        `Reescreva ${part === 'title' ? 'o título' : part === 'description' ? 'a descrição (para YouTube)' : 'as palavras-chave (de 5 a 20, separadas por vírgula)'} de um vídeo, em português do Brasil.`,
        context, `Versão atual:\n"""\n${current}\n"""`,
        requests ? `Pedidos de alteração do cliente (atenda todos):\n${requests}` : 'Sem pedidos específicos: faça uma versão melhor e diferente da atual.',
      ].join('\n\n'),
    })
    let value = out.value
    // Os créditos dos bancos de imagens continuam no fim da descrição.
    const credits = (meta.description ?? '').split('\n\nCréditos:\n')[1]
    if (part === 'description' && credits) value += `\n\nCréditos:\n${credits}`
    appliedIn = await prisma.$transaction(async (tx) => {
      const last = await tx.metadataField.aggregate({ where: { projectId: project.id, field: part }, _max: { version: true } })
      await tx.metadataField.updateMany({ where: { projectId: project.id, field: part }, data: { isCurrent: false } })
      return (await tx.metadataField.create({ data: { projectId: project.id, field: part, version: (last._max.version ?? 0) + 1, value, createdBy: 'claude' } })).version
    })
  }

  if (part === 'caption') {
    const track = project.captionTracks[0]
    if (!track) throw new Error('Projeto sem legenda para regerar')
    const out = await askClaude({
      jobId: job.id, cwd: tmpdir(), effort: 'medium',
      schema: z.object({ segments: z.array(z.object({ index: z.number().int().min(0), text: z.string().min(1).max(200), highlights: z.array(z.number().int().min(0)) })) }),
      prompt: [
        'Revise as legendas de um vídeo em português do Brasil. Mantenha o mesmo número de linhas e a mesma ordem (os tempos não mudam). Você pode corrigir texto, pontuação e escolher as palavras em destaque (índices das palavras da linha, começando em 0).',
        `Modo de destaque: ${track.highlightMode}.`, context,
        `Legendas atuais:\n${JSON.stringify(track.segments.map((s, index) => ({ index, text: s.text, highlights: JSON.parse(s.highlights) })))}`,
        requests ? `Pedidos de alteração do cliente (atenda todos):\n${requests}` : 'Sem pedidos específicos: melhore clareza e destaques.',
      ].join('\n\n'),
    })
    const byIndex = new Map(out.segments.map((s) => [s.index, s]))
    const { id: _id, segments, version: _v, createdAt: _c, updatedAt: _u, isCurrent: _i, ...style } = track
    appliedIn = await prisma.$transaction(async (tx) => {
      const last = await tx.captionTrack.aggregate({ where: { projectId: project.id }, _max: { version: true } })
      await tx.captionTrack.updateMany({ where: { projectId: project.id }, data: { isCurrent: false } })
      const t = await tx.captionTrack.create({
        data: {
          ...style, version: (last._max.version ?? 0) + 1,
          segments: {
            create: segments.map((s, i) => {
              const n = byIndex.get(i)
              const words = (n?.text ?? s.text).split(/\s+/).length
              return { startS: s.startS, endS: s.endS, text: n?.text ?? s.text, highlights: JSON.stringify((n?.highlights ?? JSON.parse(s.highlights)).filter((h: number) => h < words)) }
            }),
          },
        },
      })
      return t.version
    })
    await queueRender(project.id)
  }

  if (part === 'video') {
    if (!script) throw new Error('Projeto sem roteiro')
    const out = await askClaude({
      jobId: job.id, cwd: tmpdir(), effort: 'high', schema: VideoChanges,
      prompt: [
        'Você edita o plano de cenas de um vídeo já pronto. Aplique os pedidos de alteração do cliente mudando SÓ as cenas necessárias; devolva apenas as cenas alteradas, pelo índice.',
        'Para trocar a imagem de uma cena, mande `media` novo (imagem do cliente pelo índice, banco de imagens com 2 a 3 termos em inglês, ou quadro de texto). Para mudar a fala, mande `narration`.',
        context,
        `Cenas atuais:\n${script.scenes.map((s) => `${s.index}. [${fmt(s.startS)}–${fmt(s.endS)}] ${s.narration ?? ''}${s.onScreenText ? ` | na tela: ${s.onScreenText}` : ''}`).join('\n')}`,
        project.assets.length ? `Imagens do cliente: ${project.assets.map((a, i) => `${i}: ${a.userCaption ?? 'sem legenda'}`).join('; ')}` : 'O cliente não enviou imagens.',
        `Pedidos de alteração (o tempo indica o quadro do vídeo onde o cliente marcou):\n${requests}`,
      ].join('\n\n'),
    })
    const changes = new Map(out.changes.map((c) => [c.index, c]))
    const narrationChanged = out.changes.some((c) => c.narration !== undefined)
    const imageIds = project.assets.map((a) => a.id)
    // Nova versão do roteiro: cenas sem pedido ficam iguais (mesma mídia); as alteradas buscam mídia de novo.
    appliedIn = await prisma.$transaction(async (tx) => {
      await tx.script.create({
        data: {
          projectId: project.id, version: script.version + 1, body: script.body, createdBy: 'claude',
          scenePlan: script.scenePlan,
          scenes: {
            create: script.scenes.map((sc) => {
              const c = changes.get(sc.index)
              const m = c?.media
              return {
                index: sc.index, startS: sc.startS, endS: sc.endS,
                narration: c?.narration ?? sc.narration, onScreenText: c?.onScreenText ?? sc.onScreenText, transition: c?.transition ?? sc.transition,
                assetId: m ? (m.type === 'user_image' ? imageIds[m.imageIndex] ?? null : null) : sc.assetId,
                searchQuery: m ? (m.type === 'user_image' ? null : JSON.stringify(m)) : sc.searchQuery,
              }
            }),
          },
        },
      })
      // Fala nova = legenda nova (a antiga não bate mais com o áudio).
      if (narrationChanged) await tx.captionTrack.updateMany({ where: { projectId: project.id }, data: { isCurrent: false } })
      return ((await tx.videoVersion.aggregate({ where: { projectId: project.id }, _max: { version: true } }))._max.version ?? 0) + 1
    })
    await prisma.project.update({ where: { id: project.id }, data: { status: 'media' } })
    await prisma.job.create({ data: { projectId: project.id, type: 'media', stage: 'Na fila' } })
  }

  await prisma.changeRequest.updateMany({
    where: { id: { in: project.changeRequests.map((c) => c.id) } },
    data: { status: 'applied', appliedInVersion: appliedIn },
  })
}

async function queueRender(projectId: string) {
  await prisma.project.update({ where: { id: projectId }, data: { status: 'rendering' } })
  await prisma.job.create({ data: { projectId, type: 'render', stage: 'Na fila' } })
}
