import { execFile } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { decryptSecret, logEvent, prisma, STORAGE_DIR } from '@corte/db'
import { PROVIDERS, type IntegrationCategory } from '@corte/shared'

const run = promisify(execFile)

export type StockCandidate = {
  provider: string; sourceId: string; kind: 'image' | 'video'; url: string; pageUrl: string
  description: string; color: string | null; author: string; license: string; durationS?: number
}
type Active = { provider: string; config: Record<string, string>; secrets: Record<string, string> }

// Integrações ligadas de uma categoria, por prioridade.
// Vale a preferência do usuário; o que ele não configurou segue o padrão do admin; as locais (builtIn) vêm ligadas.
export async function activeProviders(category: IntegrationCategory, userId?: string | null): Promise<Active[]> {
  const rows = await prisma.integration.findMany({
    where: { category, OR: [{ ownerId: null }, ...(userId ? [{ ownerId: userId }] : [])] },
    include: { secrets: true },
  })
  const list: (Active & { priority: number; mine: boolean })[] = []
  for (const p of PROVIDERS.filter((x) => x.category === category)) {
    const mine = userId ? rows.find((r) => r.provider === p.provider && r.ownerId === userId) : undefined
    const row = mine ?? rows.find((r) => r.provider === p.provider && r.ownerId === null)
    if (row ? !row.enabled : !p.builtIn) continue
    const secrets = Object.fromEntries((row?.secrets ?? []).map((s) => [s.name, decryptSecret(s)]))
    if (p.secrets.some((n) => !secrets[n])) continue // ligada mas sem chave: não dá para usar
    list.push({ provider: p.provider, priority: row?.priority ?? p.priority, mine: !!mine, config: { ...p.config, ...(row ? JSON.parse(row.config) : {}) }, secrets })
  }
  // Mesma prioridade: a do usuário vem antes da do sistema.
  return list.sort((a, b) => a.priority - b.priority || Number(b.mine) - Number(a.mine))
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
}
const warn = (provider: string, message: string, userId?: string | null) =>
  logEvent({ level: 'warn', source: 'worker', kind: 'integration', message: `${provider}: ${message}`, details: { provider }, userId })

// ---------- bancos de imagens ----------
/* eslint-disable @typescript-eslint/no-explicit-any */
async function pexels(a: Active, query: string, kind: 'image' | 'video', orientation: string): Promise<StockCandidate[]> {
  const h = { Authorization: a.secrets.api_key }
  const q = `query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=5`
  if (kind === 'image') {
    const d = await getJson(`https://api.pexels.com/v1/search?${q}`, h)
    return d.photos.map((p: any) => ({
      provider: 'pexels', sourceId: String(p.id), kind, url: p.src.original, pageUrl: p.url, description: p.alt || query,
      color: p.avg_color, author: p.photographer, license: 'Pexels License',
    }))
  }
  const d = await getJson(`https://api.pexels.com/videos/search?${q}`, h)
  return d.videos.flatMap((v: any) => {
    const files = v.video_files.filter((f: any) => f.file_type === 'video/mp4' && f.width).sort((x: any, y: any) => Math.abs(x.width - 1920) - Math.abs(y.width - 1920))
    return files[0] ? [{ provider: 'pexels', sourceId: String(v.id), kind, url: files[0].link, pageUrl: v.url, description: query, color: null, author: v.user?.name ?? 'Pexels', license: 'Pexels License', durationS: v.duration }] : []
  })
}

async function pixabay(a: Active, query: string, kind: 'image' | 'video', orientation: string): Promise<StockCandidate[]> {
  const q = `key=${encodeURIComponent(a.secrets.api_key)}&q=${encodeURIComponent(query)}&per_page=5&safesearch=true`
  if (kind === 'image') {
    const d = await getJson(`https://pixabay.com/api/?${q}&image_type=photo&orientation=${orientation === 'portrait' ? 'vertical' : 'horizontal'}`)
    return d.hits.map((h: any) => ({ provider: 'pixabay', sourceId: String(h.id), kind, url: h.largeImageURL, pageUrl: h.pageURL, description: h.tags, color: null, author: h.user, license: 'Pixabay Content License' }))
  }
  const d = await getJson(`https://pixabay.com/api/videos/?${q}`)
  return d.hits.map((h: any) => ({ provider: 'pixabay', sourceId: String(h.id), kind, url: h.videos.large.url || h.videos.medium.url, pageUrl: h.pageURL, description: h.tags, color: null, author: h.user, license: 'Pixabay Content License', durationS: h.duration }))
}

// Openverse: imagens Creative Commons, sem chave. Só licenças que permitem uso comercial e modificação.
async function openverse(_a: Active, query: string, kind: 'image' | 'video', orientation: string): Promise<StockCandidate[]> {
  if (kind === 'video') return []
  const aspect = orientation === 'portrait' ? 'tall' : orientation === 'square' ? 'square' : 'wide'
  const d = await getJson(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license_type=commercial,modification&aspect_ratio=${aspect}&size=large&page_size=5`,
    { 'User-Agent': 'CorteFinal/1.0 (local)' })
  return d.results.map((r: any) => ({
    provider: 'openverse', sourceId: String(r.id), kind, url: r.url, pageUrl: r.foreign_landing_url ?? r.url, description: r.title || query,
    color: null, author: r.creator ?? 'autor desconhecido', license: `CC ${String(r.license).toUpperCase()} ${r.license_version ?? ''}`.trim(),
  }))
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const STOCK: Record<string, typeof pexels> = { pexels, pixabay, openverse }

// Tenta cada banco por prioridade; se um falhar ou estourar a cota, vai para o próximo.
export async function searchStock(queries: string[], kind: 'image' | 'video', orientation: string, userId?: string | null) {
  for (const a of await activeProviders('banco_de_imagens', userId)) {
    try {
      const found: StockCandidate[] = []
      for (const q of queries) {
        for (const c of await STOCK[a.provider](a, q, kind, orientation)) if (!found.some((f) => f.sourceId === c.sourceId)) found.push(c)
        if (found.length >= 5) break
      }
      if (found.length) return found.slice(0, 5)
    } catch (e) {
      warn(a.provider, (e as Error).message, userId)
    }
  }
  return []
}

// ---------- voz ----------
const VOICES_DIR = join(STORAGE_DIR, 'voices')
const PIPER_BIN = process.env.PIPER_PATH ?? resolve(import.meta.dirname, '../../../.venv-tts/bin/piper')
const PIPER_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR'

// O modelo da voz (~60 MB) é baixado uma vez, na primeira fala.
async function piperModel(voice: string) {
  const name = `pt_BR-${voice.replace(/[^a-z]/g, '')}-medium`
  const file = join(VOICES_DIR, `${name}.onnx`)
  if (!existsSync(file)) {
    await mkdir(VOICES_DIR, { recursive: true })
    for (const ext of ['onnx', 'onnx.json']) {
      const res = await fetch(`${PIPER_BASE}/${voice}/medium/${name}.${ext}`, { signal: AbortSignal.timeout(5 * 60_000) })
      if (!res.ok || !res.body) throw new Error(`download da voz ${voice}: HTTP ${res.status}`)
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(join(VOICES_DIR, `${name}.${ext}`)))
    }
  }
  return file
}

async function piperSpeak(text: string, model: string, speed: number, out: string) {
  await new Promise<void>((ok, fail) => {
    // length-scale menor = fala mais rápida; pausa curta entre frases deixa a leitura corrida, sem "travadas".
    const p = execFile(PIPER_BIN, ['-m', model, '--length-scale', (1 / speed).toFixed(3), '--sentence-silence', '0.12', '-f', out], (e) => (e ? fail(e) : ok()))
    p.stdin?.end(text)
  })
}

// Gera a fala em `outBase`.wav (48 kHz estéreo) e devolve o caminho. null = nenhuma voz disponível.
export async function synthesize(text: string, outBase: string, ffmpeg: string, userId?: string | null): Promise<{ path: string; provider: string } | null> {
  const wav = outBase + '.wav'
  const toWav = (input: string) => run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-ar', '48000', '-ac', '2', wav])
  for (const a of await activeProviders('voz', userId)) {
    try {
      if (a.provider === 'piper') {
        const raw = outBase + '.piper.wav'
        await piperSpeak(text, await piperModel(a.config.voice || 'faber'), Number(a.config.speed) || 1.08, raw)
        await toWav(raw)
      } else if (a.provider === 'elevenlabs') {
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(a.config.voice_id)}?output_format=mp3_44100_128`, {
          method: 'POST', signal: AbortSignal.timeout(120_000),
          headers: { 'xi-api-key': a.secrets.api_key, 'content-type': 'application/json' },
          body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.35 } }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await writeFile(outBase + '.mp3', Buffer.from(await res.arrayBuffer()))
        await toWav(outBase + '.mp3')
      } else if (a.provider === 'openai_tts') {
        const res = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST', signal: AbortSignal.timeout(120_000),
          headers: { authorization: `Bearer ${a.secrets.api_key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: a.config.voice || 'coral', input: text, response_format: 'wav',
            instructions: 'Português do Brasil. Fale como uma pessoa contando uma história para um amigo: ritmo natural, entonação viva, sem pausas longas.' }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await writeFile(outBase + '.openai.wav', Buffer.from(await res.arrayBuffer()))
        await toWav(outBase + '.openai.wav')
      } else if (a.provider === 'google_tts') {
        const voice = a.config.voice || 'pt-BR-Neural2-B'
        const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(a.secrets.api_key)}`, {
          method: 'POST', signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: { text }, voice: { languageCode: 'pt-BR', name: voice }, audioConfig: { audioEncoding: 'LINEAR16', speakingRate: 1.08 } }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await writeFile(outBase + '.google.wav', Buffer.from((await res.json()).audioContent, 'base64'))
        await toWav(outBase + '.google.wav')
      } else if (a.provider === 'macos_say') {
        await run('say', ['-v', a.config.voice || 'Luciana', '-r', '190', '-o', outBase + '.aiff', '--', text])
        await toWav(outBase + '.aiff')
      } else continue
      return { path: wav, provider: a.provider }
    } catch (e) {
      warn(a.provider, `voz falhou: ${(e as Error).message}`, userId)
    }
  }
  return null
}

// ---------- música ----------
export async function pickMusic(userId?: string | null): Promise<string | null> {
  if (!(await activeProviders('música', userId)).some((a) => a.provider === 'local_music')) return null
  const dir = join(STORAGE_DIR, 'music')
  const files = (await readdir(dir).catch(() => [])).filter((f) => /\.(mp3|m4a|wav)$/i.test(f))
  return files.length ? join(dir, files[Math.floor(Math.random() * files.length)]) : null
}

// ---------- botão "Testar": chamada mínima, sem devolver a resposta bruta ----------
export async function testIntegration(provider: string, secrets: Record<string, string>, config: Record<string, string>) {
  const a: Active = { provider, secrets, config }
  try {
    if (provider === 'pexels') await pexels(a, 'coffee', 'image', 'landscape')
    else if (provider === 'pixabay') await pixabay(a, 'coffee', 'image', 'landscape')
    else if (provider === 'openverse') { if (!(await openverse(a, 'coffee', 'image', 'landscape')).length) return false }
    else if (provider === 'elevenlabs') await getJson('https://api.elevenlabs.io/v1/user', { 'xi-api-key': secrets.api_key })
    else if (provider === 'openai_tts') await getJson('https://api.openai.com/v1/models/gpt-4o-mini-tts', { authorization: `Bearer ${secrets.api_key}` })
    else if (provider === 'google_tts') await getJson(`https://texttospeech.googleapis.com/v1/voices?languageCode=pt-BR&key=${encodeURIComponent(secrets.api_key)}`)
    else if (provider === 'omnivoice') { if (!(await fetch(`${process.env.OMNIVOICE_API_URL ?? 'http://127.0.0.1:3900'}/health`, { signal: AbortSignal.timeout(3000) })).ok) return false }
    else if (provider === 'piper') { await piperModel(config.voice || 'faber'); await run(PIPER_BIN, ['--help']) }
    else if (provider === 'macos_say') await run('say', ['-v', config.voice || 'Luciana', '-o', '/dev/null', 'ok'])
    else if (provider === 'local_music') await readdir(join(STORAGE_DIR, 'music'))
    return true
  } catch { return false }
}
