import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma, STORAGE_DIR, type Job } from '@corte/db'
import { MAX_DURATION_S } from '@corte/shared'
import { durationOf, FFMPEG, run } from './ffmpeg.js'
import { INTRO_S } from './media-job.js'

const FPS = 30
const FADE = 0.25 // transição: escurece e clareia rápido entre um corte e outro

// Sorteia trechos de 3 a 6 s dos vídeos enviados, sem repetir trecho enquanto houver vídeo novo, até cobrir `totalS`.
export function pickCuts(sources: { path: string; durationS: number }[], totalS: number, random = Math.random, before: { path: string; startS: number; lenS: number }[] = []) {
  const used = new Map<string, [number, number][]>()
  for (const b of before) used.set(b.path, [...(used.get(b.path) ?? []), [b.startS, b.startS + b.lenS]])
  const cuts: { path: string; startS: number; lenS: number }[] = []
  let t = 0
  while (t < totalS) {
    const lenS = Math.min(3 + random() * 3, Math.max(1, totalS - t + FADE))
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

const clipArgs = (src: string, startS: number, lenS: number, out: string) => ['-hide_banner', '-loglevel', 'error', '-y', '-ss', startS.toFixed(3), '-i', src, '-t', lenS.toFixed(3), '-an',
  '-vf', `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${FPS},setsar=1,fade=t=in:d=${FADE},fade=t=out:st=${Math.max(0, lenS - FADE).toFixed(3)}:d=${FADE},format=yuv420p`,
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', String(FPS), out]

// Só vídeos com vídeos enviados: corta os enviados em trechos (3 a 6 s) e para na aprovação dos cortes.
// payload.count: quantos cortes novos (repor os reprovados). payload.assemble: monta o vídeo com os aprovados.
export async function montage(job: Job) {
  const { count, assemble: join_ } = JSON.parse(job.payload ?? '{}') as { count?: number; assemble?: boolean }
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: job.projectId },
    include: { assets: { where: { kind: { in: ['user_video', 'footage_cut', 'footage_clip'] } } }, scripts: { orderBy: { version: 'desc' }, take: 1, include: { scenes: true } } },
  })
  const uploads = project.assets.filter((a) => a.kind === 'user_video')
  if (!uploads.length) throw new Error('Envie pelo menos um vídeo para cortar')
  await prisma.project.update({ where: { id: project.id }, data: { status: 'media' } })
  // Tamanho pela fala estimada (~14 caracteres por segundo) com folga; o render corta no tamanho exato da narração.
  const chars = (project.scripts[0]?.scenes ?? []).reduce((n, s) => n + (s.narration?.length ?? 0), 0)
  const totalS = Math.min(MAX_DURATION_S + 60, INTRO_S + (chars / 14) * 1.3 + 20)
  const dir = join(STORAGE_DIR, 'montage', project.id)
  await mkdir(dir, { recursive: true })
  if (join_) return assemble(job, project.id, project.assets.filter((a) => a.kind === 'footage_clip'), totalS, dir)

  // Trechos já usados (aprovados, pendentes ou reprovados antes) não voltam.
  const sources = await Promise.all(uploads.map(async (a) => ({ path: a.filePath, durationS: await durationOf(a.filePath) })))
  const taken = project.assets.filter((a) => a.kind !== 'user_video' && a.sourceId).map((a) => JSON.parse(a.sourceId!) as { path: string; startS: number; lenS: number })
  // Reprovados já foram apagados; os trechos deles ficam guardados nas opções para não serem cortados de novo.
  const avoid = (JSON.parse(project.options).cutRanges ?? []) as { path: string; startS: number; lenS: number }[]
  const cuts = pickCuts(sources, count ? count * 4.5 : totalS, Math.random, [...taken, ...avoid])
  for (const [i, c] of cuts.entries()) {
    const out = join(dir, `corte-${Date.now()}-${i}.mp4`)
    await run(FFMPEG, clipArgs(c.path, c.startS, c.lenS, out), { maxBuffer: 16 * 1024 * 1024 })
    await prisma.asset.create({ data: { projectId: project.id, kind: 'footage_cut', filePath: out, mime: 'video/mp4', durationS: c.lenS, sourceProvider: 'upload', sourceId: JSON.stringify(c), sortOrder: i } })
    if (i % 10 === 0) await prisma.job.update({ where: { id: job.id }, data: { stage: `Cortando os vídeos enviados · corte ${i + 1} de ${cuts.length}`, progress: Math.round((i / cuts.length) * 95) } })
  }
  // Para aqui: a pessoa aprova ou reprova cada corte (10 min; passou, aprova sozinho).
  await prisma.project.update({ where: { id: project.id }, data: { status: 'cut_review', reviewUntil: new Date(Date.now() + 10 * 60_000) } })
}

// Monta o vídeo com os cortes aprovados, em ordem aleatória, repetindo em loop se faltar tempo. Depois vem a narração.
async function assemble(job: Job, projectId: string, clips: { filePath: string; durationS: number | null }[], totalS: number, dir: string) {
  if (!clips.length) throw new Error('Nenhum corte aprovado. Faça novos cortes ou envie outros vídeos.')
  const order: string[] = []
  for (let t = 0, round = [...clips]; t < totalS;) {
    if (!round.length) round = [...clips]
    const [c] = round.splice(Math.floor(Math.random() * round.length), 1)
    order.push(c.filePath); t += c.durationS ?? 4
  }
  await prisma.job.update({ where: { id: job.id }, data: { stage: `Montando o vídeo com ${clips.length} cortes aprovados`, progress: 50 } })
  const work = await mkdtemp(join(tmpdir(), 'darkviews-montagem-'))
  try {
    await writeFile(join(work, 'lista.txt'), order.map((f) => `file '${f}'`).join('\n'))
    const file = join(dir, `montagem-${Date.now()}.mp4`)
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'lista.txt', '-c', 'copy', file], { cwd: work, maxBuffer: 16 * 1024 * 1024 })
    const fresh = JSON.parse((await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { options: true } })).options)
    await prisma.project.update({ where: { id: projectId }, data: { options: JSON.stringify({ ...fresh, montage: file }) } })
  } finally { await rm(work, { recursive: true, force: true }) }
  // Vídeo pronto: agora a narração.
  await prisma.job.create({ data: { projectId, type: 'voice', stage: 'Na fila' } })
}
