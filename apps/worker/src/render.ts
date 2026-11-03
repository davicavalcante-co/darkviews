import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma, STORAGE_DIR, type Job } from '@corte/db'
import { MAX_DURATION_S } from '@corte/shared'
import { buildSegments, toAss, type CaptionStyle, type Segment, type TimedScene } from './captions.js'
import { assertLibass, durationOf, FFMPEG, run } from './ffmpeg.js'
import { ensureFont, FONTS_DIR } from './fonts.js'

const FPS = 30
const X264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS)]

export type RenderScene = { durationS: number; kind: 'image' | 'video' | 'card'; path?: string; transition: string; voice: string | null }
// cleanOut: cópia sem legenda (mesmo vídeo e áudio), base dos cortes verticais.
export type RenderInput = { scenes: RenderScene[]; music: string | null; ass: string; fontsDir: string; out: string; cleanOut?: string; onProgress?: (p: number) => Promise<unknown> }

// Transição de entrada de cada cena: [tipo do xfade do FFmpeg, duração]. "cut" vira uma dissolvência rápida.
const TRANSITIONS: Record<string, [string, number]> = { fade: ['fade', 0.45], slide: ['slideleft', 0.45], zoom: ['zoomin', 0.45], cut: ['fade', 0.12] }

// extraS: o clipe dura um pouco mais que a cena para sobrepor com a próxima na transição (o total não muda).
function clipArgs(s: RenderScene, i: number, out: string, extraS = 0): string[] {
  const len = s.durationS + extraS
  const frames = Math.round(len * FPS)
  const fade = ''
  if (s.kind === 'image') {
    // Movimento contínuo e variado, cena a cena: aproxima, afasta, desliza para a direita e para a esquerda.
    // A intensidade acompanha a duração (on = quadro atual, d = total), então cenas curtas também se mexem.
    const zIn = `1+0.22*on/${frames}`, zOut = `1.22-0.22*on/${frames}`
    const motion = [
      { z: zIn, x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' },
      { z: '1.18', x: `(iw-iw/zoom)*on/${frames}`, y: 'ih/2-(ih/zoom/2)' },
      { z: zOut, x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' },
      { z: '1.18', x: `(iw-iw/zoom)*(1-on/${frames})`, y: 'ih/2-(ih/zoom/2)' },
    ][i % 4]
    return ['-i', s.path!, '-vf',
      `scale=2304:1296:force_original_aspect_ratio=increase,crop=2304:1296,zoompan=z='${motion.z}':x='${motion.x}':y='${motion.y}':d=${frames}:s=1920x1080:fps=${FPS}${fade}`,
      '-frames:v', String(frames), ...X264, '-preset', 'veryfast', '-crf', '18', out]
  }
  if (s.kind === 'video') {
    return ['-stream_loop', '-1', '-i', s.path!, '-t', len.toFixed(3), '-an', '-vf',
      `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${FPS}${fade}`, ...X264, '-preset', 'veryfast', '-crf', '18', out]
  }
  return ['-f', 'lavfi', '-i', `color=c=0x111418:s=1920x1080:r=${FPS}:d=${len.toFixed(3)}`, ...X264, '-preset', 'veryfast', '-crf', '18', out]
}

// Monta o vídeo final 1920x1080 30 fps: clipes por cena, locução casada com as cenas, trilha baixa e legenda ASS queimada.
export async function renderVideo(input: RenderInput) {
  await assertLibass()
  const total = input.scenes.reduce((n, s) => n + s.durationS, 0)
  if (total > MAX_DURATION_S) throw new Error('Vídeo acima de 18 minutos')
  const work = await mkdtemp(join(tmpdir(), 'corte-render-'))
  const ff = (args: string[]) => run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: work, maxBuffer: 16 * 1024 * 1024 })
  try {
    const clips: string[] = [], audios: string[] = []
    const into = input.scenes.map((s, i) => (i === 0 ? null : TRANSITIONS[s.transition] ?? TRANSITIONS.fade))
    for (const [i, s] of input.scenes.entries()) {
      const clip = `clip-${String(i).padStart(4, '0')}.mp4`
      await ff(clipArgs(s, i, clip, into[i + 1]?.[1] ?? 0))
      // Áudio da cena com a duração exata dela: fala + silêncio até o fim.
      const wav = `audio-${String(i).padStart(4, '0')}.wav`
      await ff(s.voice
        ? ['-i', s.voice, '-af', `apad,atrim=0:${s.durationS.toFixed(3)}`, '-ar', '48000', '-ac', '2', wav]
        : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', s.durationS.toFixed(3), wav])
      clips.push(clip); audios.push(wav)
      await input.onProgress?.(Math.round(((i + 1) / input.scenes.length) * 75))
    }
    await writeFile(join(work, 'audios.txt'), audios.map((c) => `file '${c}'`).join('\n'))
    if (clips.length === 1) {
      await ff(['-i', clips[0], '-c', 'copy', 'video.mp4'])
    } else {
      // Dissolvências entre as cenas: a transição k começa onde a cena k-1 terminaria, então a voz continua sincronizada.
      let graph = clips.map((_, k) => `[${k}:v]settb=AVTB,setpts=PTS-STARTPTS[c${k}]`).join(';')
      let prev = 'c0', offset = 0
      for (let k = 1; k < clips.length; k++) {
        offset += input.scenes[k - 1].durationS
        const [type, d] = into[k]!
        graph += `;[${prev}][c${k}]xfade=transition=${type}:duration=${d}:offset=${offset.toFixed(3)}[x${k}]`
        prev = `x${k}`
      }
      await ff([...clips.flatMap((c) => ['-i', c]), '-filter_complex', graph, '-map', `[${prev}]`, ...X264, '-preset', 'veryfast', '-crf', '17', 'video.mp4'])
    }
    await ff(['-f', 'concat', '-safe', '0', '-i', 'audios.txt', '-c', 'copy', 'narracao.wav'])
    await writeFile(join(work, 'legendas.ass'), input.ass)
    await symlink(input.fontsDir, join(work, 'fonts'))
    await input.onProgress?.(80)

    const args = ['-i', 'video.mp4', '-i', 'narracao.wav']
    // Narração: corta o grave que embola, compressão leve (voz presente e constante) e volume no padrão do YouTube (-16 LUFS).
    const voiceChain = 'highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=8:release=180:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=9'
    let audio = `[1:a]${voiceChain}[a]`
    if (input.music) {
      args.push('-stream_loop', '-1', '-i', input.music)
      // Música abaixa sozinha enquanto há fala e volta nas pausas (ducking).
      audio = `[1:a]${voiceChain},asplit=2[v][key];[2:a]volume=0.35[m0];[m0][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[m];[v][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`
    }
    await mkdir(join(input.out, '..'), { recursive: true })
    await ff([...args, '-filter_complex', `[0:v]subtitles=legendas.ass:fontsdir=fonts[v];${audio}`, '-map', '[v]', '-map', '[a]',
      ...X264, '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3), '-movflags', '+faststart', input.out])
    if (input.cleanOut) {
      // Vídeo copiado sem reencode: só o áudio é misturado de novo.
      await ff([...args, '-filter_complex', audio, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3), input.cleanOut])
    }
    await input.onProgress?.(100)
    return input.out
  } finally { await rm(work, { recursive: true, force: true }) }
}

type SceneRow = { index: number; startS: number; endS: number; narration: string | null; onScreenText: string | null; searchQuery: string | null; asset: unknown }
export function timedScenes(scenes: SceneRow[], voices: Map<number, { durationS: number | null }>): TimedScene[] {
  return scenes.map((s) => {
    const card = !s.asset
    const q = s.searchQuery ? JSON.parse(s.searchQuery) : null
    return {
      startS: s.startS, endS: s.endS, speechS: voices.get(s.index)?.durationS ?? 0, narration: s.narration ?? '',
      onScreenText: card ? (q?.text || s.onScreenText || '') : s.onScreenText, isCard: card,
    }
  })
}

export function trackStyle(t: { fontFamily: string; fontWeight: number; size: number; color: string; highlightColor: string; highlightMode: string; position: string }): CaptionStyle {
  return { fontFamily: t.fontFamily, fontWeight: t.fontWeight, size: t.size, color: t.color, highlightColor: t.highlightColor, highlightMode: t.highlightMode, position: t.position }
}

const DEFAULT_STYLE = { size: 64, color: '#FFFFFF', highlightColor: '#FFD43B', position: 'bottom-center' }

export async function render(job: Job) {
  const project = await prisma.project.update({
    where: { id: job.projectId }, data: { status: 'rendering' },
    include: {
      scripts: { orderBy: { version: 'desc' }, take: 1, include: { scenes: { orderBy: { index: 'asc' }, include: { asset: true } } } },
      assets: { where: { kind: { in: ['voice', 'music'] } } },
      metadataFields: { where: { isCurrent: true } },
      captionTracks: { where: { isCurrent: true }, include: { segments: { orderBy: { startS: 'asc' } } } },
    },
  })
  const scenes = project.scripts[0]?.scenes
  if (!scenes?.length) throw new Error('Projeto sem cenas')
  const opts = JSON.parse(project.options) as { fontFamily?: string; highlightMode?: string; highlightColor?: string; captionPosition?: string }
  const voices = new Map(project.assets.filter((a) => a.kind === 'voice').map((a) => [a.sortOrder, a]))
  const music = project.assets.find((a) => a.kind === 'music')?.filePath ?? null
  const keywords = (project.metadataFields.find((m) => m.field === 'keywords')?.value ?? '').split(',').map((k) => k.trim())

  const timed = timedScenes(scenes, voices)

  // Usa a trilha de legenda atual (editada na Fase 5) ou cria a primeira a partir da narração.
  let track = project.captionTracks[0]
  if (!track) {
    const fontFamily = opts.fontFamily ?? 'Montserrat'
    const segs = buildSegments(timed, opts.highlightMode ?? 'palavra-chave', keywords)
    track = await prisma.captionTrack.create({
      data: {
        projectId: project.id, version: 1, fontFamily, fontWeight: 700, ...DEFAULT_STYLE, ...(opts.highlightColor && { highlightColor: opts.highlightColor }), ...(opts.captionPosition && { position: opts.captionPosition }), highlightMode: opts.highlightMode ?? 'palavra-chave',
        segments: { create: segs.map((s) => ({ startS: s.startS, endS: s.endS, text: s.text, highlights: JSON.stringify(s.highlights) })) },
      },
      include: { segments: { orderBy: { startS: 'asc' } } },
    })
  }
  await prisma.job.update({ where: { id: job.id }, data: { stage: 'Baixando a fonte das legendas', progress: 2 } })
  await ensureFont(track.fontFamily, track.fontWeight)
  const style = trackStyle(track)
  const segments: Segment[] = track.segments.map((s) => ({ startS: s.startS, endS: s.endS, text: s.text, highlights: JSON.parse(s.highlights) }))

  const version = ((await prisma.videoVersion.aggregate({ where: { projectId: project.id }, _max: { version: true } }))._max.version ?? 0) + 1
  const out = join(STORAGE_DIR, 'renders', project.id, `v${version}.mp4`)
  const cleanOut = join(STORAGE_DIR, 'renders', project.id, `v${version}-sem-legenda.mp4`)
  await renderVideo({
    scenes: scenes.map((s) => ({
      durationS: s.endS - s.startS,
      kind: !s.asset ? 'card' : s.asset.kind.endsWith('video') ? 'video' : 'image',
      path: s.asset?.filePath, transition: s.transition ?? 'cut', voice: voices.get(s.index)?.filePath ?? null,
    })),
    music, ass: toAss(segments, timed, style), fontsDir: FONTS_DIR, out, cleanOut,
    onProgress: (p) => prisma.job.update({ where: { id: job.id }, data: { stage: p < 80 ? 'Criando vídeo: cenas' : 'Criando vídeo: legendas e áudio', progress: p } }),
  })

  await prisma.$transaction([
    prisma.videoVersion.updateMany({ where: { projectId: project.id }, data: { isCurrent: false } }),
    prisma.videoVersion.create({
      data: { projectId: project.id, version, filePath: out, durationS: await durationOf(out), renderSettings: JSON.stringify({ width: 1920, height: 1080, fps: FPS, captionTrack: track.id, clean: cleanOut }) },
    }),
  ])
  await addCredits(project.id)
  await prisma.project.update({ where: { id: project.id }, data: { status: 'editing' } })
}

// A descrição final já sai com os créditos exigidos pelos bancos de imagens.
async function addCredits(projectId: string) {
  const credits = (await prisma.asset.findMany({ where: { projectId, attribution: { not: null }, scenes: { some: {} } }, select: { attribution: true } }))
    .map((a) => a.attribution!).filter((v, i, a) => a.indexOf(v) === i)
  if (!credits.length) return
  const current = await prisma.metadataField.findFirst({ where: { projectId, field: 'description', isCurrent: true } })
  const base = (current?.value ?? '').split('\n\nCréditos:\n')[0]
  const value = `${base}\n\nCréditos:\n${credits.join('\n')}`
  if (value === current?.value) return
  await prisma.$transaction([
    prisma.metadataField.updateMany({ where: { projectId, field: 'description' }, data: { isCurrent: false } }),
    prisma.metadataField.create({ data: { projectId, field: 'description', version: (current?.version ?? 0) + 1, value, createdBy: 'system' } }),
  ])
}
