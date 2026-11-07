import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma, projectDir, type Job } from '@corte/db'
import { DEFAULT_IDENTITY, MAX_DURATION_S, MUSIC_STYLES, type Identity } from '@corte/shared'
import { pickMusic } from '@corte/providers'
import { randomUUID } from 'node:crypto'
import { buildSegments, retimeSegments, toAss, type CaptionStyle, type Segment, type TimedScene, type TitleStyle } from './captions.js'
import { assertLibass, durationOf, FFMPEG, run } from './ffmpeg.js'
import { ensureFont, FONTS_DIR } from './fonts.js'
import { subjectMask } from './subject.js'

const FPS = 30
const X264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS)]

export type RenderScene = { durationS: number; kind: 'image' | 'video' | 'card'; path?: string; transition: string; voice: string | null; bg?: string; motion?: string; easing?: string; mask?: string; offsetS?: number }
// cleanOut: cópia sem legenda (mesmo vídeo e áudio), base dos cortes verticais.
export type RenderInput = { scenes: RenderScene[]; music: string | null; musicVolume?: number; sfxVolume?: number; ass: string; fontsDir: string; out: string; cleanOut?: string; onProgress?: (p: number) => Promise<unknown> }

// Transição de entrada de cada cena: [tipo do xfade do FFmpeg, duração]. "cut" vira uma dissolvência rápida.
// Os cortes secos usam 1 quadro de transição (na prática, corte direto).
const TRANSITIONS: Record<string, [string, number]> = {
  fade: ['fade', 0.45], cut: ['fade', 1 / FPS], punch_in: ['fade', 1 / FPS], punch_out: ['fade', 1 / FPS],
  zoom_through: ['zoomin', 0.5], zoom: ['zoomin', 0.45],
  slide_left: ['slideleft', 0.35], slide_right: ['slideright', 0.35], slide_up: ['slideup', 0.35], slide_down: ['slidedown', 0.35], slide: ['slideleft', 0.35],
  whip: ['hblur', 0.3], // chicote: troca rápida com borrão horizontal
}

// Curvas de animação sobre o progresso p (0 → 1) da cena.
function ease(easing: string | undefined, p: string) {
  if (easing === 'linear') return p
  if (easing === 'ease_in') return `(${p})*(${p})`
  if (easing === 'ease_out') return `(1-(1-${p})*(1-${p}))`
  return `if(lt(${p},0.5),2*(${p})*(${p}),1-pow(-2*(${p})+2,2)/2)` // ease_in_out
}
const ENC = (frames: number, out: string) => ['-frames:v', String(frames), ...X264, '-preset', 'veryfast', '-crf', '18', out]

// Efeitos para fotos. Devolve null quando não se aplica (cai no Ken Burns).
function imageEffect(s: RenderScene, i: number, len: number, frames: number, out: string): string[] | null {
  const P = `min(1,on/${frames})`, E = ease(s.easing, P)
  if (s.motion === 'static') return ['-i', s.path!, '-vf', `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,loop=-1:1,fps=${FPS}`, ...ENC(frames, out)]
  if (s.motion === 'snap_zoom') {
    // Zoom brusco: parado até ~35% da cena, salta para 1,3x em 6 quadros (ease out) e segue aproximando devagar.
    const at = Math.round(frames * 0.35)
    const z = `if(lt(on,${at}),1,1.3*(1-pow(1-min(1,(on-${at})/6),3))+(1-(1-pow(1-min(1,(on-${at})/6),3)))+0.04*(on-${at})/${frames})`
    return ['-i', s.path!, '-vf', `scale=2880:1620:force_original_aspect_ratio=increase,crop=2880:1620,zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1920x1080:fps=${FPS}`, ...ENC(frames, out)]
  }
  if (s.motion === 'cutout') {
    // Recorte de revista: foto com borda branca e sombra sobre papel, entrando em degraus e tremendo a cada 4 quadros (stop-motion).
    const tilt = [0.025, -0.02, 0.015, -0.03][i % 4]
    const jx = '6*sin(floor(n/4)*2.3)', jy = '5*cos(floor(n/4)*1.7)', enter = `140*max(0,1-floor(t*8)/4)`
    const g = [
      `color=c=0xEDE4D0:s=1920x1080:r=${FPS}:d=${len.toFixed(3)},noise=alls=10:allf=u,format=yuv420p[bg]`,
      `[0]scale=1440:800:force_original_aspect_ratio=decrease,pad=iw+40:ih+40:20:20:color=white,format=rgba,loop=-1:1,fps=${FPS},rotate=a='${tilt}+0.012*sin(floor(n/4)*2.1)':c=none:ow=rotw(0.08):oh=roth(0.08),split[f][s0]`,
      `[s0]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.45,boxblur=14[sh]`,
      `[bg][sh]overlay=x='(W-w)/2+16+${jx}':y='(H-h)/2+20+${jy}+${enter}':shortest=1[b1]`,
      `[b1][f]overlay=x='(W-w)/2+${jx}':y='(H-h)/2+${jy}+${enter}':shortest=1,format=yuv420p`,
    ].join(';')
    return ['-i', s.path!, '-filter_complex', g, ...ENC(frames, out)]
  }
  if (s.motion === 'parallax' && s.mask) {
    // 2.5D: o fundo aproxima devagar e o objeto (recortado pela máscara) desliza mais rápido por cima.
    const Et = ease(s.easing, `min(1,t/${len.toFixed(3)})`), dir = i % 2 ? 1 : -1
    const g = [
      `[0]scale=2304:1296:force_original_aspect_ratio=increase,crop=2304:1296,boxblur=2,zoompan=z='1+0.06*${E}':x='(iw-iw/zoom)*(0.5+${0.25 * dir}*${E})':y='ih/2-(ih/zoom/2)':d=${frames}:s=1920x1080:fps=${FPS}[bg]`,
      `[1]scale=2112:1188:force_original_aspect_ratio=increase,crop=2112:1188,loop=-1:1,fps=${FPS}[fi]`,
      `[2]scale=2112:1188:force_original_aspect_ratio=increase,crop=2112:1188,format=gray,loop=-1:1,fps=${FPS}[m]`,
      `[fi][m]alphamerge[fg]`,
      `[bg][fg]overlay=x='(W-w)/2+${-80 * dir}*${Et}':y='(H-h)/2-24*${Et}':shortest=1,format=yuv420p`,
    ].join(';')
    return ['-i', s.path!, '-i', s.path!, '-i', s.mask, '-filter_complex', g, ...ENC(frames, out)]
  }
  return null
}

// extraS: o clipe dura um pouco mais que a cena para sobrepor com a próxima na transição (o total não muda).
function clipArgs(s: RenderScene, i: number, out: string, extraS = 0): string[] {
  const len = s.durationS + extraS
  const frames = Math.round(len * FPS)
  const fade = ''
  // Zoom seco: imagem parada que, no meio da cena, salta para mais perto (punch_in) ou mais longe (punch_out), como trocar de câmera.
  if ((s.transition === 'punch_in' || s.transition === 'punch_out') && s.kind !== 'card') {
    const half = Math.round(frames / 2), [a, b] = s.transition === 'punch_in' ? [1, 1.3] : [1.3, 1]
    const n = s.kind === 'image' ? 'on' : 'in'
    const zp = `zoompan=z='if(lt(${n},${half}),${a},${b})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${s.kind === 'image' ? frames : 1}:s=1920x1080:fps=${FPS}`
    return s.kind === 'image'
      ? ['-i', s.path!, '-vf', `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,${zp}`, '-frames:v', String(frames), ...X264, '-preset', 'veryfast', '-crf', '18', out]
      : ['-stream_loop', '-1', '-ss', (s.offsetS ?? 0).toFixed(3), '-i', s.path!, '-t', len.toFixed(3), '-an', '-vf', `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${FPS},${zp}`, ...X264, '-preset', 'veryfast', '-crf', '18', out]
  }
  if (s.kind === 'image') {
    const fx = imageEffect(s, i, len, frames, out)
    if (fx) return fx
    // Ken Burns: movimento contínuo e variado, cena a cena: aproxima, afasta, desliza para a direita e para a esquerda.
    // A intensidade acompanha a duração (on = quadro atual, d = total), então cenas curtas também se mexem.
    // Zoom combinado com um leve pan, na curva escolhida (easing).
    const E = ease(s.easing, `min(1,on/${frames})`)
    const motion = [
      { z: `1+0.12*${E}`, x: `(iw-iw/zoom)*(0.4+0.2*${E})`, y: 'ih/2-(ih/zoom/2)' },
      { z: `1.12-0.12*${E}`, x: `(iw-iw/zoom)*(0.6-0.2*${E})`, y: 'ih/2-(ih/zoom/2)' },
      { z: `1.04+0.08*${E}`, x: 'iw/2-(iw/zoom/2)', y: `(ih-ih/zoom)*(0.55-0.2*${E})` },
      { z: '1.1', x: `(iw-iw/zoom)*(0.8-0.6*${E})`, y: 'ih/2-(ih/zoom/2)' },
    ][i % 4]
    return ['-i', s.path!, '-vf',
      `scale=2880:1620:force_original_aspect_ratio=increase,crop=2880:1620,zoompan=z='${motion.z}':x='${motion.x}':y='${motion.y}':d=${frames}:s=1920x1080:fps=${FPS}${fade}`,
      '-frames:v', String(frames), ...X264, '-preset', 'veryfast', '-crf', '18', out]
  }
  if (s.kind === 'video') {
    // offsetS: de onde o trecho começa no vídeo (o vídeo enviado é distribuído pelas cenas sem voltar ao início).
    return ['-stream_loop', '-1', '-ss', (s.offsetS ?? 0).toFixed(3), '-i', s.path!, '-t', len.toFixed(3), '-an', '-vf',
      `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=${FPS}${fade}`, ...X264, '-preset', 'veryfast', '-crf', '18', out]
  }
  // Cartela: a foto da cena vizinha desfocada e tingida com a cor de fundo (como as cartelas de capítulo das referências).
  if (s.path) {
    const g = `[0]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=18,eq=saturation=0.35:brightness=-0.08,loop=-1:1,fps=${FPS}[b];color=c=0x${(s.bg ?? '#111418').slice(1)}@0.72:s=1920x1080:r=${FPS}:d=${len.toFixed(3)}[t];[b][t]overlay=shortest=1,zoompan=z='1+0.05*on/${frames}':d=1:s=1920x1080:fps=${FPS},format=yuv420p`
    return ['-i', s.path, '-filter_complex', g, ...ENC(frames, out)]
  }
  return ['-f', 'lavfi', '-i', `color=c=0x${(s.bg ?? '#111418').slice(1)}:s=1920x1080:r=${FPS}:d=${len.toFixed(3)}`, ...X264, '-preset', 'veryfast', '-crf', '18', out]
}

// Monta o vídeo final 1920x1080 30 fps: clipes por cena, locução casada com as cenas, trilha baixa e legenda ASS queimada.
export async function renderVideo(input: RenderInput) {
  await assertLibass()
  const total = input.scenes.reduce((n, s) => n + s.durationS, 0)
  if (total > MAX_DURATION_S) throw new Error('Vídeo acima de 60 minutos')
  const work = await mkdtemp(join(tmpdir(), 'corte-render-'))
  const ff = (args: string[]) => run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: work, maxBuffer: 16 * 1024 * 1024 })
  try {
    const clips: string[] = [], audios: string[] = []
    const into = input.scenes.map((s, i) => (i === 0 ? null : TRANSITIONS[s.transition] ?? TRANSITIONS.fade))
    for (const [i, s0] of input.scenes.entries()) {
      const clip = `clip-${String(i).padStart(4, '0')}.mp4`
      const s = s0.kind === 'image' ? await fitImage(s0, i, work, ff) : s0
      const len = s.durationS + (into[i + 1]?.[1] ?? 0)
      await ff(clipArgs(s, i, clip, into[i + 1]?.[1] ?? 0)).catch(async (e) => {
        // Efeito que falhou nesta imagem: refaz a cena com o movimento simples, em vez de derrubar o vídeo.
        if (s.kind !== 'image' || !s.motion || s.motion === 'ken_burns') throw e
        await ff(clipArgs({ ...s, motion: 'ken_burns' }, i, clip, into[i + 1]?.[1] ?? 0))
      })
      // Cena curta demais quebra a montagem (o vídeo congelava no meio): completa repetindo o último quadro.
      if ((await durationOf(join(work, clip))) < len - 0.08) {
        const fixed = `fix-${clip}`
        await ff(['-i', clip, '-vf', `tpad=stop_mode=clone:stop_duration=${len.toFixed(3)}`, '-t', len.toFixed(3), ...X264, '-preset', 'veryfast', '-crf', '18', fixed])
        await rename(join(work, fixed), join(work, clip))
      }
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
      // Offsets pela duração real de cada clipe. Em blocos de 40 clipes: um comando com 150+ entradas o FFmpeg não aguenta
      // (vídeo longo falhava só no fim). Cada bloco termina com a sobra da transição seguinte, então juntar os blocos com a
      // mesma transição dá o mesmo resultado de uma corrente só.
      const chain = async (files: string[], into0: ([string, number] | null)[], out: string) => {
        if (files.length === 1) return ff(['-i', files[0], '-c', 'copy', out])
        let graph = files.map((_, k) => `[${k}:v]settb=AVTB,setpts=PTS-STARTPTS[c${k}]`).join(';')
        const lens = await Promise.all(files.map((c) => durationOf(join(work, c))))
        let prev = 'c0', offset = 0, acc = lens[0]
        for (let k = 1; k < files.length; k++) {
          const [type, d] = into0[k]!
          offset = acc - d
          acc = offset + lens[k]
          graph += `;[${prev}][c${k}]xfade=transition=${type}:duration=${d}:offset=${(Math.floor(offset * 1000) / 1000).toFixed(3)}[x${k}]`
          prev = `x${k}`
        }
        await ff([...files.flatMap((c) => ['-i', c]), '-filter_complex', graph, '-map', `[${prev}]`, ...X264, '-preset', 'veryfast', '-crf', '17', out])
      }
      const SIZE = 40
      const blocks: string[] = [], blockInto: ([string, number] | null)[] = []
      for (let k = 0; k < clips.length; k += SIZE) {
        const out = `bloco-${String(k / SIZE).padStart(3, '0')}.mp4`
        await chain(clips.slice(k, k + SIZE), into.slice(k, k + SIZE), out)
        blocks.push(out); blockInto.push(k === 0 ? null : into[k])
      }
      await chain(blocks, blockInto, 'video.mp4')
    }
    // O vídeo montado precisa ter a duração toda; se não tiver, para aqui com o motivo em vez de entregar um vídeo congelado.
    const built = await durationOf(join(work, 'video.mp4'))
    if (built < total - 0.5) throw new Error(`A montagem das cenas saiu com ${built.toFixed(1)} s de ${total.toFixed(1)} s`)
    await ff(['-f', 'concat', '-safe', '0', '-i', 'audios.txt', '-c', 'copy', 'narracao.wav'])
    // Efeitos sonoros nas transições e nos zooms rápidos (gerados aqui mesmo, sem licença de terceiros).
    const sfx = input.sfxVolume === 0 ? null : await buildSfx(input.scenes, into, work, ff, total)
    await writeFile(join(work, 'legendas.ass'), input.ass)
    await symlink(input.fontsDir, join(work, 'fonts'))
    await input.onProgress?.(80)

    const args = ['-i', 'video.mp4', '-i', 'narracao.wav', ...(sfx ? ['-i', sfx] : [])]
    const sfxIn = sfx ? 2 : -1, musicIn = sfx ? 3 : 2
    // Narração: corta o grave que embola, compressão leve (voz presente e constante) e volume no padrão do YouTube (-16 LUFS).
    const voiceChain = 'highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=8:release=180:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=9'
    // Mistura: voz (+ música com ducking) (+ efeitos sonoros).
    const mix = (inputs: string[]) => (inputs.length === 1 ? `${inputs[0]}anull[a]` : `${inputs.join('')}amix=inputs=${inputs.length}:duration=first:dropout_transition=0:normalize=0[a]`)
    let audio: string
    if (input.music) {
      args.push('-stream_loop', '-1', '-i', input.music)
      // Música: cada faixa é nivelada no mesmo volume da voz (-16 LUFS), para o % do editor valer igual em qualquer trilha;
      // depois abaixa um pouco enquanto há fala e volta nas pausas (ducking leve: com 8:1 ela sumia e trocar a trilha não fazia diferença).
      audio = `[1:a]${voiceChain},asplit=2[vo][key];[${musicIn}:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,volume=${(input.musicVolume ?? 35) / 100}[m0];[m0][key]sidechaincompress=threshold=0.05:ratio=3:attack=20:release=400[m];${sfx ? `[${sfxIn}:a]volume=${(input.sfxVolume ?? 55) / 100}[fx];` : ''}${mix(['[vo]', '[m]', ...(sfx ? ['[fx]'] : [])])}`
    } else {
      audio = `[1:a]${voiceChain}[vo];${sfx ? `[${sfxIn}:a]volume=${(input.sfxVolume ?? 55) / 100}[fx];` : ''}${mix(['[vo]', ...(sfx ? ['[fx]'] : [])])}`
    }
    await mkdir(join(input.out, '..'), { recursive: true })
    await ff([...args, '-filter_complex', `[0:v]fade=t=in:st=0:d=3:color=0x${(input.scenes[0]?.bg ?? '#000000').replace('#', '')},subtitles=legendas.ass:fontsdir=fonts[v];${audio}`, '-map', '[v]', '-map', '[a]',
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
      // O texto editado no editor vale mais que o do roteiro original.
      onScreenText: card ? (s.onScreenText ?? q?.text ?? '') : s.onScreenText, isCard: card,
    }
  })
}

export function trackStyle(t: { fontFamily: string; fontWeight: number; size: number; color: string; highlightColor: string; highlightMode: string; position: string; outline?: boolean }): CaptionStyle {
  return { fontFamily: t.fontFamily, fontWeight: t.fontWeight, size: t.size, color: t.color, highlightColor: t.highlightColor, highlightMode: t.highlightMode, position: t.position, outline: t.outline }
}


// Queima só a legenda da fala sobre o vídeo base (que já tem cartelas e destaques). O áudio é copiado.
export async function burnCaptions(src: string, ass: string, out: string) {
  await assertLibass()
  const work = await mkdtemp(join(tmpdir(), 'corte-legenda-'))
  try {
    await writeFile(join(work, 'legendas.ass'), ass)
    await symlink(FONTS_DIR, join(work, 'fonts'))
    await mkdir(join(out, '..'), { recursive: true })
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vf', 'subtitles=legendas.ass:fontsdir=fonts', ...X264, '-preset', 'medium', '-crf', '20', '-c:a', 'copy', '-movflags', '+faststart', out], { cwd: work, maxBuffer: 16 * 1024 * 1024 })
  } finally { await rm(work, { recursive: true, force: true }) }
}

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
  // captionsOn: a pessoa aplicou a legenda na aba Legendas. Até lá o vídeo sai sem a legenda da fala.
  const opts = JSON.parse(project.options) as { captionsOn?: boolean; bgColor?: string; musicVolume?: number; sfxVolume?: number; titleStyle?: TitleStyle; musicStyle?: string; musicPicked?: string | null; pendingChanges?: string[] }
  const { captionsOnly, titlesOnly } = JSON.parse(job.payload ?? '{}') as { captionsOnly?: boolean; titlesOnly?: boolean }
  const voices = new Map(project.assets.filter((a) => a.kind === 'voice').map((a) => [a.sortOrder, a]))
  let music = project.assets.find((a) => a.kind === 'music')?.filePath ?? null
  const keywords = (project.metadataFields.find((m) => m.field === 'keywords')?.value ?? '').split(',').map((k) => k.trim())

  const timed = timedScenes(scenes, voices)
  // Onde a fala de cada cena começa e termina de verdade (a pausa de entrada e de saída não leva legenda).
  for (const [i, s] of scenes.entries()) {
    const file = voices.get(s.index)?.filePath
    if (!file || !existsSync(file)) continue
    const [on, off] = await speechBounds(file)
    timed[i].speechStartS = Math.min(s.startS + on, s.endS)
    timed[i].speechEndS = Math.min(s.startS + off, s.endS)
  }
  const identityRow = await prisma.setting.findUnique({ where: { key: `identity:${project.ownerId}` } })
  const identity: Identity = identityRow ? { ...DEFAULT_IDENTITY, ...JSON.parse(identityRow.value) } : DEFAULT_IDENTITY
  opts.titleStyle ??= identity.title
  opts.bgColor ??= identity.bgColor

  // Usa a trilha de legenda atual (editada na aba Legendas) ou cria a primeira a partir da narração, no estilo padrão.
  let track = project.captionTracks[0]
  if (!track) {
    // Nova versão do vídeo: a fala mudou, então o texto é refeito, mas no mesmo estilo da legenda anterior.
    const last = await prisma.captionTrack.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' } })
    const style0 = last ? { fontFamily: last.fontFamily, fontWeight: last.fontWeight, size: last.size, color: last.color, highlightColor: last.highlightColor, position: last.position, highlightMode: last.highlightMode, outline: last.outline } : identity.caption
    const segs = buildSegments(timed, style0.highlightMode, keywords)
    track = await prisma.captionTrack.create({
      data: {
        // Numeração continua as versões antigas (a anterior fica no histórico).
        projectId: project.id, version: (last?.version ?? 0) + 1, ...style0,
        segments: { create: segs.map((s) => ({ startS: s.startS, endS: s.endS, text: s.text, highlights: JSON.stringify(s.highlights) })) },
      },
      include: { segments: { orderBy: { startS: 'asc' } } },
    })
  }
  await prisma.job.update({ where: { id: job.id }, data: { stage: 'Baixando a fonte das legendas', progress: 2 } })
  await ensureFont(track.fontFamily, track.fontWeight)
  const style = trackStyle(track)
  if (opts.titleStyle) await ensureFont(opts.titleStyle.fontFamily, 700)
  // A legenda acompanha sempre a fala atual: refaz os tempos (o texto fica) e guarda, para o editor mostrar igual.
  const segments: Segment[] = retimeSegments(track.segments.map((s) => ({ startS: s.startS, endS: s.endS, text: s.text, highlights: JSON.parse(s.highlights) })), timed)
  const moved = track.segments.map((row, i) => ({ id: row.id, ...segments[i] })).filter((x, i) => x.startS !== track!.segments[i].startS || x.endS !== track!.segments[i].endS)
  if (moved.length) await prisma.$transaction(moved.map((x) => prisma.captionSegment.update({ where: { id: x.id }, data: { startS: x.startS, endS: x.endS } })))

  const version = ((await prisma.videoVersion.aggregate({ where: { projectId: project.id }, _max: { version: true } }))._max.version ?? 0) + 1
  const dir = await projectDir(project.id, 'videos')
  // base: vídeo com cartelas e destaques, sem a legenda da fala. clean: sem nada escrito (cortes verticais).
  let base = join(dir, `v${version}-base.mp4`), cleanOut = join(dir, `v${version}-sem-legenda.mp4`)
  const prev = await prisma.videoVersion.findFirst({ where: { projectId: project.id, isCurrent: true } })
  const prevSettings = JSON.parse(prev?.renderSettings ?? '{}') as { base?: string; clean?: string }
  // Só mudou a legenda: aproveita o vídeo base da versão atual em vez de montar tudo de novo.
  const reuse = captionsOnly && prevSettings.base && prevSettings.clean && existsSync(prevSettings.base)
  if (reuse) { base = prevSettings.base!; cleanOut = prevSettings.clean! }
  // Só mudaram enunciados (texto ou estilo): escreve os títulos de novo sobre o vídeo limpo atual. Sem áudio, sem montar as cenas.
  const retitle = !reuse && titlesOnly && prevSettings.clean && existsSync(prevSettings.clean)
  if (retitle) {
    cleanOut = prevSettings.clean!
    await prisma.job.update({ where: { id: job.id }, data: { stage: 'Escrevendo os enunciados', progress: 40 } })
    await burnCaptions(cleanOut, toAss([], timed, style, undefined, true, opts.titleStyle), base)
  }
  // Cartela sem imagem própria usa a foto da cena mais próxima como fundo tingido.
  const photos = scenes.filter((x) => x.asset && !x.asset.kind.endsWith('video'))
  const nearPhoto = (idx: number) => photos.reduce<typeof photos[number] | null>((b, x) => (!b || Math.abs(x.index - idx) < Math.abs(b.index - idx) ? x : b), null)?.asset?.filePath

  // Recorte do objeto só para as fotos com parallax.
  const masks = new Map<number, string>()
  if (!reuse && !retitle) for (const s of scenes) if (s.motion === 'parallax' && s.asset && !s.asset.kind.endsWith('video')) { const m = await subjectMask(s.asset.filePath); if (m) masks.set(s.index, m) }

  if (!reuse && !retitle) {
    await prisma.job.update({ where: { id: job.id }, data: { stage: 'Trilha sonora', progress: 4 } })
    music = await syncMusic(project.id, project.ownerId, opts, music, timed.at(-1)?.endS ?? 0)
  }
  const onFrame = (t: number) => Math.round(t * FPS) / FPS
  // Vídeo usado em várias cenas: cada cena continua de onde a anterior parou (volta ao começo só quando o vídeo acaba).
  const cursor = new Map<string, number>(), lengthOf = new Map<string, number>()
  const offsets = new Map<number, number>()
  if (!reuse && !retitle) for (const s of scenes) {
    const path = s.asset?.kind.endsWith('video') ? s.asset.filePath : null
    if (!path) continue
    if (!lengthOf.has(path)) lengthOf.set(path, await durationOf(path).catch(() => 0))
    const at = cursor.get(path) ?? 0, total = lengthOf.get(path)!
    offsets.set(s.index, total > 1 ? at % total : 0)
    cursor.set(path, at + (s.endS - s.startS))
  }
  if (!reuse && !retitle) await renderVideo({
    scenes: scenes.map((s) => ({
      // Começo e fim de cada cena no quadro exato: com 100+ cenas, arredondar cada duração separado somava atraso entre imagem e fala.
      durationS: onFrame(s.endS) - onFrame(s.startS), offsetS: offsets.get(s.index),
      kind: !s.asset ? 'card' : s.asset.kind.endsWith('video') ? 'video' : 'image',
      path: s.asset?.filePath ?? nearPhoto(s.index), transition: s.transition ?? 'cut', voice: voices.get(s.index)?.filePath ?? null, bg: opts.bgColor,
      motion: s.motion ?? undefined, easing: s.easing ?? undefined, mask: masks.get(s.index),
    })),
    music, musicVolume: opts.musicVolume, sfxVolume: opts.sfxVolume, ass: toAss([], timed, style, undefined, true, opts.titleStyle), fontsDir: FONTS_DIR, out: base, cleanOut,
    onProgress: (p) => prisma.job.update({ where: { id: job.id }, data: { stage: p < 80 ? 'Vídeo: imagens, movimentos, transições e efeitos' : 'Áudio final: narração, trilha e efeitos sonoros', progress: p } }),
  })
  let out = base
  if (opts.captionsOn) {
    await prisma.job.update({ where: { id: job.id }, data: { stage: 'Aplicando a legenda', progress: 90 } })
    out = join(dir, `v${version}.mp4`)
    await burnCaptions(base, toAss(segments, timed, style, undefined, false), out)
  }

  await prisma.$transaction([
    prisma.videoVersion.updateMany({ where: { projectId: project.id }, data: { isCurrent: false } }),
    prisma.videoVersion.create({
      data: { projectId: project.id, version, filePath: out, durationS: await durationOf(out), renderSettings: JSON.stringify({ width: 1920, height: 1080, fps: FPS, captionTrack: opts.captionsOn ? track.id : null, base, clean: cleanOut, changes: opts.pendingChanges ?? [],
        source: { name: project.name, prompt: project.prompt, targetDurationS: project.targetDurationS, options: (({ pendingChanges: _p, musicPicked: _m, ...o }) => o)(opts) } }) },
    }),
  ])
  // As mudanças anotadas no editor ficaram gravadas nesta versão; a lista recomeça vazia.
  const fresh = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { options: true } })
  await prisma.project.update({ where: { id: project.id }, data: { options: JSON.stringify({ ...JSON.parse(fresh.options), pendingChanges: [] }) } })
  await addCredits(project.id)
  await prisma.project.update({ where: { id: project.id }, data: { status: 'editing' } })
}

// A descrição final já sai com os créditos exigidos pelos bancos de imagens.
async function addCredits(projectId: string) {
  const credits = (await prisma.asset.findMany({ where: { projectId, attribution: { not: null }, OR: [{ scenes: { some: {} } }, { kind: 'music' }] }, select: { attribution: true } }))
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

type FF = (args: string[]) => Promise<unknown>

// Foto fora do 16:9 (retrato, quadrada, panorâmica) não é ampliada até cortar o assunto:
// fica inteira no centro, sobre uma cópia dela desfocada preenchendo a tela.
async function fitImage(s: RenderScene, i: number, work: string, ff: FF): Promise<RenderScene> {
  const out = `foto-${i}.jpg`
  const [w, h] = (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', s.path!])).stdout.trim().split(',').map(Number)
  if (!w || !h || (w / h >= 1.5 && w / h <= 2.0)) return s
  await ff(['-i', s.path!, '-filter_complex', '[0]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=30,eq=brightness=-0.1[b];[0]scale=1920:1080:force_original_aspect_ratio=decrease[f];[b][f]overlay=(W-w)/2:(H-h)/2', '-q:v', '2', out])
  // O recorte do parallax foi feito na foto original: com a foto ajustada, usa Ken Burns.
  return { ...s, path: join(work, out), ...(s.motion === 'parallax' && { motion: 'ken_burns', mask: undefined }) }
}

// Efeitos sonoros: "whoosh" nas transições com movimento e "impacto" nos zooms secos, nos tempos certos das cenas.
async function buildSfx(scenes: RenderScene[], into: ([string, number] | null)[], work: string, ff: FF, total: number) {
  const WHOOSH = new Set(['whip', 'slide_left', 'slide_right', 'slide_up', 'slide_down', 'slide', 'zoom_through', 'zoom'])
  const HIT = new Set(['punch_in', 'punch_out'])
  const hits: { at: number; kind: 'whoosh' | 'hit' }[] = []
  let t = 0
  scenes.forEach((s, k) => {
    if (k > 0 && WHOOSH.has(s.transition)) hits.push({ at: Math.max(0, t - 0.25), kind: 'whoosh' })
    if (k > 0 && HIT.has(s.transition)) hits.push({ at: t, kind: 'hit' })
    if (s.kind === 'image' && s.motion === 'snap_zoom') hits.push({ at: t + s.durationS * 0.35, kind: 'hit' })
    t += s.durationS
  })
  if (!hits.length) return null
  // Whoosh: ruído rosa filtrado subindo e descendo; impacto: grave curto com estalo.
  await ff(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=0.6:amplitude=0.9', '-af', 'highpass=f=300,lowpass=f=4000,afade=t=in:d=0.3:curve=exp,afade=t=out:st=0.3:d=0.3,volume=0.8', '-ar', '48000', '-ac', '2', 'whoosh.wav'])
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=55:duration=0.5', '-f', 'lavfi', '-i', 'anoisesrc=color=white:duration=0.05:amplitude=0.6', '-filter_complex', '[0]afade=t=out:st=0:d=0.5:curve=exp,volume=1.6[a];[1]lowpass=f=1800[b];[a][b]amix=inputs=2:normalize=0', '-ar', '48000', '-ac', '2', 'hit.wav'])
  const inputs = hits.flatMap((h) => ['-i', `${h.kind}.wav`])
  const graph = hits.map((h, k) => `[${k}]adelay=${Math.round(h.at * 1000)}:all=1[s${k}]`).join(';') + `;${hits.map((_, k) => `[s${k}]`).join('')}amix=inputs=${hits.length}:normalize=0,apad,atrim=0:${total.toFixed(3)}`
  await ff([...inputs, '-filter_complex', graph, '-ar', '48000', '-ac', '2', 'efeitos.wav'])
  return 'efeitos.wav'
}

// Trilha escolhida no editor: busca uma nova quando o estilo muda; "sem trilha" (ou nada escolhido) tira a música.
// musicPicked indefinido = projeto antigo, cuja trilha já veio da criação e fica como está.
async function syncMusic(projectId: string, ownerId: string, opts: { musicStyle?: string; musicPicked?: string | null }, current: string | null, durationS: number) {
  const want = opts.musicStyle && opts.musicStyle !== 'none' ? MUSIC_STYLES.find((m) => m.id === opts.musicStyle) ?? MUSIC_STYLES[0] : null
  if (want?.id === 'upload') return current // trilha enviada pela pessoa: nunca troca
  if (current && (!want || (opts.musicPicked !== undefined && opts.musicPicked !== want.id))) {
    await prisma.asset.deleteMany({ where: { projectId, kind: 'music' } })
    current = null
  }
  if (!want || current) return current
  const dir = await projectDir(projectId, 'midia')
  const m = await pickMusic(ownerId, want.tags, durationS, join(dir, `trilha-${randomUUID().slice(0, 8)}`))
  if (m) await prisma.asset.create({ data: { projectId, kind: 'music', filePath: m.path, mime: 'audio/mpeg', sourceProvider: m.provider, license: m.license, attribution: m.attribution || null } })
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { options: true } })
  await prisma.project.update({ where: { id: projectId }, data: { options: JSON.stringify({ ...JSON.parse(p.options), musicPicked: want.id }) } })
  return m?.path ?? null
}

// Início e fim da fala num áudio (s), ignorando o silêncio das pontas.
export async function speechBounds(file: string): Promise<[number, number]> {
  const { stderr } = await run(FFMPEG, ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-40dB:d=0.08', '-f', 'null', '-'], { maxBuffer: 8 * 1024 * 1024 })
  const total = await durationOf(file)
  const starts = [...stderr.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Math.max(0, Number(m[1])))
  const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]))
  const on = starts.length && starts[0] < 0.02 && ends.length ? ends[0] : 0
  const off = starts.length && starts.at(-1)! > on && (ends.length < starts.length || ends.at(-1)! >= total - 0.05) ? starts.at(-1)! : total
  return [on, Math.max(on, off)]
}
