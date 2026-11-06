import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

// Folha de contato: vários quadros numa imagem só, da esquerda para a direita, linha a linha; devolve o tempo de cada um.
// O Claude abre UM arquivo em vez de dezenas — cada abertura extra reenviava todo o contexto e multiplicava os tokens.
export async function contactSheet(video: string, durationS: number, dir: string, count = 24, cols = 6) {
  const step = durationS / count
  const out = join(dir, 'folha-de-quadros.jpg')
  const rows = Math.ceil(count / cols)
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', (step / 2).toFixed(2), '-i', video, '-vf',
    `fps=1/${step.toFixed(3)},scale=320:-2,tile=${cols}x${rows}`,
    '-frames:v', '1', '-q:v', '4', out])
  return { file: out, cols, times: Array.from({ length: count }, (_, i) => +(step * (i + 0.5)).toFixed(1)) }
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

// Várias imagens numa folha só (grade, da esquerda para a direita), para o Claude ver todas com uma leitura.
export async function imageSheet(paths: string[], out: string, cols = 6) {
  const n = paths.length, rows = Math.ceil(n / cols)
  const scaled = paths.map((_, i) => `[${i}:v]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`).join(';')
  const concat = `${paths.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0,tile=${cols}x${rows}:padding=4`
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...paths.flatMap((p) => ['-i', p]), '-filter_complex', `${scaled};${concat}`, '-frames:v', '1', '-q:v', '4', out])
  return out
}

// Quantas palavras do texto aparecem no que foi ouvido (0 a 1), sem acento nem pontuação.
export function wordRecall(text: string, heard: string) {
  const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  const left = new Map<string, number>()
  for (const w of words(heard)) left.set(w, (left.get(w) ?? 0) + 1)
  const ref = words(text)
  let hit = 0
  for (const w of ref) if (left.get(w)) { hit++; left.set(w, left.get(w)! - 1) }
  return ref.length ? hit / ref.length : 1
}

// A fala ficou clara? O Whisper ouve o áudio e compara com o texto. null = Whisper não instalado (pula a conferência).
export async function clarity(audio: string, text: string): Promise<number | null> {
  const model = process.env.WHISPER_MODEL
  if (!model || !existsSync(model)) return null
  const dir = await mkdtemp(join(tmpdir(), 'darkviews-clareza-'))
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', audio, '-ar', '16000', '-ac', '1', join(dir, 'a.wav')])
    await run('whisper-cli', ['-m', model, '-f', join(dir, 'a.wav'), '-l', 'pt', '-nt', '-otxt', '-of', join(dir, 't')], BIG)
    return wordRecall(text, await readFile(join(dir, 't.txt'), 'utf8'))
  } finally { await rm(dir, { recursive: true, force: true }) }
}
