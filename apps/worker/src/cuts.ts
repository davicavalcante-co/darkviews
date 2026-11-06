import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma, projectDir, type Job } from '@corte/db'
import { DEFAULT_IDENTITY } from '@corte/shared'
import { toAss, type CaptionStyle, type Segment, type TimedScene } from './captions.js'
import { assertLibass, FFMPEG, run } from './ffmpeg.js'
import { ensureFont, FONTS_DIR } from './fonts.js'
import { timedScenes, trackStyle } from './render.js'

// O vídeo horizontal inteiro, reduzido à largura da tela vertical (1080x608), no meio; atrás, ele mesmo embaçado ou a cor de fundo.
// A legenda fica no fundo, abaixo do vídeo.
export function verticalFilter(background: string, bgColor: string) {
  const fg = 'scale=1080:-2:flags=lanczos'
  return background === 'color'
    ? `[0:v]${fg},pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x${bgColor.replace('#', '')},setsar=1,subtitles=legendas.ass:fontsdir=fonts[v]`
    : `[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=40:4,eq=brightness=-0.1[bg];[b]${fg}[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,subtitles=legendas.ass:fontsdir=fonts[v]`
}

// Recorta um trecho [start, end], monta a tela vertical e queima a legenda.
export async function renderCut(o: { clean: string; startS: number; endS: number; background: string; bgColor: string; ass: string; fontsDir: string; out: string }) {
  const work = await mkdtemp(join(tmpdir(), 'corte-vertical-'))
  try {
    await writeFile(join(work, 'legendas.ass'), o.ass)
    await symlink(o.fontsDir, join(work, 'fonts'))
    await mkdir(join(o.out, '..'), { recursive: true })
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', o.startS.toFixed(3), '-i', o.clean, '-t', (o.endS - o.startS).toFixed(3),
      '-filter_complex', verticalFilter(o.background, o.bgColor), '-map', '[v]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', o.out],
    { cwd: work, maxBuffer: 16 * 1024 * 1024 })
  } finally { await rm(work, { recursive: true, force: true }) }
}

// Legendas e textos de tela que caem no trecho, com o tempo deslocado para começar em 0.
export function shiftToWindow(segments: Segment[], scenes: TimedScene[], startS: number, endS: number) {
  const inside = <T extends { startS: number; endS: number }>(x: T) => x.endS > startS && x.startS < endS
  const shift = <T extends { startS: number; endS: number }>(x: T): T => ({ ...x, startS: Math.max(0, x.startS - startS), endS: Math.min(endS, x.endS) - startS })
  return { segments: segments.filter(inside).map(shift), scenes: scenes.filter(inside).map(shift) }
}

export async function cuts(job: Job) {
  await assertLibass()
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: job.projectId },
    include: {
      videoVersions: { where: { isCurrent: true } },
      captionTracks: { where: { isCurrent: true }, include: { segments: { orderBy: { startS: 'asc' } } } },
      scripts: { orderBy: { version: 'desc' }, take: 1, include: { scenes: { orderBy: { index: 'asc' }, include: { asset: true } } } },
      assets: { where: { kind: 'voice' } },
      cuts: { where: { status: 'queued' }, orderBy: [{ platform: 'asc' }, { partIndex: 'asc' }] },
    },
  })
  const clean = JSON.parse(project.videoVersions[0]?.renderSettings ?? '{}').clean as string | undefined
  if (!clean) throw new Error('Renderize o vídeo de novo antes de gerar os cortes')
  const track = project.captionTracks[0]
  // Legenda sempre adaptada ao corte: o estilo do vídeo, embaixo, no fundo (fora do vídeo reduzido).
  const style: CaptionStyle | null = track ? { ...trackStyle(track), position: 'bottom-center' } : null
  if (track) await ensureFont(track.fontFamily, track.fontWeight)
  const bgColor = (JSON.parse(project.options) as { bgColor?: string }).bgColor ?? DEFAULT_IDENTITY.bgColor
  const segments: Segment[] = (track?.segments ?? []).map((s) => ({ startS: s.startS, endS: s.endS, text: s.text, highlights: JSON.parse(s.highlights) }))
  const scenes = timedScenes(project.scripts[0]?.scenes ?? [], new Map(project.assets.map((a) => [a.sortOrder, a])))

  for (const [i, cut] of project.cuts.entries()) {
    await prisma.job.update({ where: { id: job.id }, data: { stage: `Cortando ${cut.platform} parte ${cut.partIndex + 1}`, progress: Math.round((i / project.cuts.length) * 100) } })
    await prisma.cut.update({ where: { id: cut.id }, data: { status: 'running' } })
    try {
      const w = shiftToWindow(segments, scenes, cut.startS, cut.endS)
      const out = join(await projectDir(project.id, 'cortes-verticais'), `${cut.platform}-${cut.partIndex + 1}-${cut.id.slice(0, 8)}.mp4`)
      await renderCut({
        clean, startS: cut.startS, endS: cut.endS, background: cut.background, bgColor, fontsDir: FONTS_DIR, out,
        ass: style ? toAss(w.segments, w.scenes, style, { w: 1080, h: 1920 }) : toAss([], w.scenes, { fontFamily: 'Inter', fontWeight: 700, size: 64, color: '#FFFFFF', highlightColor: '#FFD43B', highlightMode: 'manual', position: 'bottom-center' }, { w: 1080, h: 1920 }),
      })
      await prisma.cut.update({ where: { id: cut.id }, data: { status: 'done', filePath: out } })
    } catch (e) {
      await prisma.cut.update({ where: { id: cut.id }, data: { status: 'failed' } })
      throw e
    }
  }
}
