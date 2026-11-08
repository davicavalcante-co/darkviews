import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma, projectDir, type Job } from '@corte/db'
import { MAX_DURATION_S } from '@corte/shared'
import { durationOf, FFMPEG, run } from './ffmpeg.js'
import { INTRO_S } from './media-job.js'
import { checkCancel } from './cancel.js'

const FPS = 30
const FADE = 0.25 // transição: escurece e clareia rápido entre um corte e outro

// Sorteia trechos de minS a maxS segundos dos vídeos enviados, sem repetir trecho enquanto houver vídeo novo, até cobrir `totalS`.
export function pickCuts(sources: { path: string; durationS: number }[], totalS: number, random = Math.random, before: { path: string; startS: number; lenS: number }[] = [], [minS, maxS] = [3, 6]) {
  const used = new Map<string, [number, number][]>()
  for (const b of before) used.set(b.path, [...(used.get(b.path) ?? []), [b.startS, b.startS + b.lenS]])
  const cuts: { path: string; startS: number; lenS: number }[] = []
  let t = 0
  while (t < totalS) {
    const lenS = Math.min(minS + random() * (maxS - minS), Math.max(1, totalS - t + FADE))
    const src = sources[Math.floor(random() * sources.length)]
    const max = Math.max(0, src.durationS - lenS)
    const taken = used.get(src.path) ?? []
    let startS = random() * max
    // Até 30 sorteios para achar um trecho ainda não usado; vídeo curto demais acaba repetindo.
    for (let k = 0; k < 30 && taken.some(([a, b]) => startS < b && startS + lenS > a); k++) startS = random() * max
    taken.push([startS, startS + lenS]); used.set(src.path, taken)
    cuts.push({ path: src.path, startS, lenS })
    t += lenS
  }
  return cuts
}

// fade: escurece no começo e no fim do recorte. Vídeo com falas não escurece (parecia pausa a cada recorte).
const clipArgs = (src: string, startS: number, lenS: number, out: string, fade = true) => ['-hide_banner', '-loglevel', 'error', '-y', '-ss', startS.toFixed(3), '-i', src, '-t', lenS.toFixed(3), '-an',
  '-vf', `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${FPS},setsar=1,${fade ? `fade=t=in:d=${FADE},fade=t=out:st=${Math.max(0, lenS - FADE).toFixed(3)}:d=${FADE},` : ''}format=yuv420p`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', String(FPS), out]

// Só vídeos com vídeos enviados: corta os enviados em trechos (3 a 6 s) e para na aprovação dos cortes.
// payload.count: quantos cortes novos (repor os reprovados). payload.assemble: monta o vídeo com os aprovados.
export async function montage(job: Job) {
  const { count, assemble: join_ } = JSON.parse(job.payload ?? '{}') as { count?: number; assemble?: boolean }
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: job.projectId },
    include: { assets: { where: { kind: { in: ['user_video', 'footage_cut', 'clip_video'] } } }, scripts: { orderBy: { version: 'desc' }, take: 1, include: { scenes: true } } },
  })
  const uploads = project.assets.filter((a) => a.kind === 'user_video')
  if (!uploads.length) throw new Error('Envie pelo menos um vídeo para cortar')
  await prisma.project.update({ where: { id: project.id }, data: { status: 'media' } })
  // Tamanho pela fala estimada (~14 caracteres por segundo) com folga; o render corta no tamanho exato da narração.
  const chars = (project.scripts[0]?.scenes ?? []).reduce((n, s) => n + (s.narration?.length ?? 0), 0)
  const totalS = Math.min(MAX_DURATION_S + 60, INTRO_S + (chars / 14) * 1.3 + 20)
  const dir = await projectDir(project.id, 'cortes-dos-envios')
  if (join_) return assign(job, project.id, project.assets.filter((a) => a.kind === 'clip_video'))

  // Trechos já usados (aprovados, pendentes ou reprovados antes) não voltam.
  const sources = await Promise.all(uploads.map(async (a) => ({ path: a.filePath, durationS: await durationOf(a.filePath) })))
  const taken = project.assets.filter((a) => a.kind !== 'user_video' && a.sourceId).map((a) => JSON.parse(a.sourceId!) as { path: string; startS: number; lenS: number })
  // Reprovados já foram apagados; os trechos deles ficam guardados nas opções para não serem cortados de novo.
  const avoid = (JSON.parse(project.options).cutRanges ?? []) as { path: string; startS: number; lenS: number }[]
  // Cenas que recebem corte: as do narrador (não as falas com corte próprio nem as cartelas).
  const quotes = JSON.parse(project.options).quotes === true
  const scenes = (project.scripts[0]?.scenes ?? []).filter((s) => !own(s)).length || Math.ceil(totalS / 5)
  // Vídeo com falas: recortes maiores (8 a 14 s), para a cena não repetir o recorte nem trocar de imagem a toda hora.
  const cuts = pickCuts(sources, (count ?? scenes) * 14, Math.random, [...taken, ...avoid], quotes ? [8, 14] : [3, 6]).slice(0, count ?? scenes)
  for (const [i, c] of cuts.entries()) {
    const out = join(dir, `corte-${Date.now()}-${i}.mp4`)
    await run(FFMPEG, clipArgs(c.path, c.startS, c.lenS, out, !quotes), { maxBuffer: 16 * 1024 * 1024 })
    await prisma.asset.create({ data: { projectId: project.id, kind: 'footage_cut', filePath: out, mime: 'video/mp4', durationS: c.lenS, sourceProvider: 'upload', sourceId: JSON.stringify(c), sortOrder: i } })
    if (i % 10 === 0) await checkCancel(job.id)
    if (i % 10 === 0) await prisma.job.update({ where: { id: job.id }, data: { stage: `Cortando os vídeos enviados · corte ${i + 1} de ${cuts.length}`, progress: Math.round((i / cuts.length) * 95) } })
  }
  // Vídeo com falas: sem aprovação dos cortes (menos trabalho); vai direto para as cenas.
  if (quotes) {
    await prisma.asset.updateMany({ where: { projectId: project.id, kind: 'footage_cut' }, data: { kind: 'clip_video' } })
    return assign(job, project.id, await prisma.asset.findMany({ where: { projectId: project.id, kind: 'clip_video' }, select: { id: true } }))
  }
  // Para aqui: a pessoa aprova ou reprova cada corte (10 min; passou, aprova sozinho).
  await prisma.project.update({ where: { id: project.id }, data: { status: 'cut_review', reviewUntil: new Date(Date.now() + 10 * 60_000) } })
}

// Igual aos outros modos: cada cena recebe um corte aprovado (em ordem aleatória; faltando, repete) e segue para a narração.
async function assign(job: Job, projectId: string, clips: { id: string }[]) {
  if (!clips.length) throw new Error('Nenhum corte aprovado. Faça novos cortes ou envie outros vídeos.')
  const script = await prisma.script.findFirst({ where: { projectId }, orderBy: { version: 'desc' }, include: { scenes: { orderBy: { index: 'asc' } } } })
  let pool: { id: string }[] = []
  const scenes = script?.scenes ?? []
  for (const [i, s] of scenes.entries()) {
    // Fala com corte e cartela ficam como estão; depois de uma fala, esmaece para o narrador.
    const afterQuote = i > 0 && scenes[i - 1].searchQuery?.includes('"type":"quote"')
    if (own(s)) { if (afterQuote) await prisma.scene.update({ where: { id: s.id }, data: { transition: 'fade' } }); continue }
    if (!pool.length) pool = [...clips].sort(() => Math.random() - 0.5)
    const c = pool.pop()!
    await prisma.scene.update({ where: { id: s.id }, data: { assetId: c.id, transition: afterQuote ? 'fade' : 'cut', motion: null, onScreenText: null } })
  }
  await prisma.job.update({ where: { id: job.id }, data: { stage: `${clips.length} cortes aprovados distribuídos nas cenas`, progress: 100 } })
  await prisma.job.create({ data: { projectId, type: 'voice', stage: 'Na fila' } })
}

// Cena que já tem a sua imagem: a fala com o corte enviado, ou uma cartela.
const own = (s: { searchQuery: string | null }) => !!s.searchQuery && (s.searchQuery.includes('"type":"quote"') || s.searchQuery.includes('"type":"text_card"'))
