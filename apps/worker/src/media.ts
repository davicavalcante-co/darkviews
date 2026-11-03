import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const BIG = { maxBuffer: 64 * 1024 * 1024 }

// Tempos (s) das trocas de cena, lidos da saída do filtro showinfo.
export function parseSceneTimes(stderr: string) {
  return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]))
}

export async function detectScenes(video: string) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-i', video, '-vf', "select='gt(scene,0.3)',showinfo", '-an', '-f', 'null', '-'], BIG)
  return parseSceneTimes(stderr)
}

// Até `count` quadros espalhados pelo vídeo, em JPG pequeno, para o Claude olhar.
export async function extractFrames(video: string, durationS: number, dir: string, count = 8) {
  await mkdir(dir, { recursive: true })
  for (let i = 0; i < count; i++) {
    const t = (durationS * (i + 0.5)) / count
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', t.toFixed(2), '-i', video, '-frames:v', '1', '-vf', 'scale=640:-2', join(dir, `quadro-${String(i + 1).padStart(2, '0')}.jpg`)])
  }
  return (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort()
}

// whisper.cpp local; sem modelo configurado, segue sem transcrição.
export async function transcribe(video: string, dir: string): Promise<string | null> {
  const model = process.env.WHISPER_MODEL
  if (!model || !existsSync(model)) return null
  const wav = join(dir, 'audio.wav')
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-ar', '16000', '-ac', '1', wav])
  try {
    await run('whisper-cli', ['-m', model, '-f', wav, '-l', 'auto', '-otxt', '-of', join(dir, 'transcricao')], BIG)
    return (await readFile(join(dir, 'transcricao.txt'), 'utf8')).trim()
  } finally { await rm(wav, { force: true }) }
}
