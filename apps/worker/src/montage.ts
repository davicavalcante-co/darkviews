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
export function pickCuts(sources: { path: string; durationS: number }[], totalS: number, random = Math.random) {
  const used = new Map<string, [number, number][]>()
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

// Método "Vídeo por cortes": primeiro monta o vídeo (cortes aleatórios dos vídeos enviados, só transição),
// depois a narração entra por cima (etapa de áudio) e o vídeo é aparado no tamanho da fala.
export async function montage(job: Job) {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: job.projectId },
    include: { assets: { where: { kind: 'user_video' } }, scripts: { orderBy: { version: 'desc' }, take: 1, include: { scenes: true } } },
  })
  if (!project.assets.length) throw new Error('Envie pelo menos um vídeo para cortar')
  await prisma.project.update({ where: { id: project.id }, data: { status: 'media' } })
  const sources = await Promise.all(project.assets.map(async (a) => ({ path: a.filePath, durationS: await durationOf(a.filePath) })))
  // Tamanho pela fala estimada (~14 caracteres por segundo) com folga; o render corta no tamanho exato da narração.
  const chars = (project.scripts[0]?.scenes ?? []).reduce((n, s) => n + (s.narration?.length ?? 0), 0)
  const totalS = Math.min(MAX_DURATION_S + 60, INTRO_S + (chars / 14) * 1.3 + 20)
  const cuts = pickCuts(sources, totalS)

  const work = await mkdtemp(join(tmpdir(), 'darkviews-montagem-'))
  try {
    const list: string[] = []
    for (const [i, c] of cuts.entries()) {
      const out = `c${String(i).padStart(5, '0')}.mp4`
      await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', c.startS.toFixed(3), '-i', c.path, '-t', c.lenS.toFixed(3), '-an',
        '-vf', `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${FPS},setsar=1,fade=t=in:d=${FADE},fade=t=out:st=${Math.max(0, c.lenS - FADE).toFixed(3)}:d=${FADE},format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', String(FPS), join(work, out)], { cwd: work, maxBuffer: 16 * 1024 * 1024 })
      list.push(`file '${out}'`)
      if (i % 10 === 0) await prisma.job.update({ where: { id: job.id }, data: { stage: `Montando o vídeo · corte ${i + 1} de ${cuts.length}`, progress: Math.round((i / cuts.length) * 95) } })
    }
    await writeFile(join(work, 'lista.txt'), list.join('\n'))
    const dir = join(STORAGE_DIR, 'montage', project.id)
    await mkdir(dir, { recursive: true })
    const file = join(dir, `montagem-${Date.now()}.mp4`)
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'lista.txt', '-c', 'copy', file], { cwd: work, maxBuffer: 16 * 1024 * 1024 })
    const fresh = JSON.parse((await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { options: true } })).options)
    await prisma.project.update({ where: { id: project.id }, data: { options: JSON.stringify({ ...fresh, montage: file }) } })
  } finally { await rm(work, { recursive: true, force: true }) }
  // Vídeo pronto: agora a narração.
  await prisma.job.create({ data: { projectId: project.id, type: 'voice', stage: 'Na fila' } })
}
