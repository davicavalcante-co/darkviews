import { execFile } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { decryptSecret, logEvent, prisma, STORAGE_DIR } from '@corte/db'
import { PROVIDERS, type IntegrationCategory } from '@corte/shared'

const run = promisify(execFile)

export type StockCandidate = {
  level?: number // 1 = fiel ao que é dito … 4 = pouca relação
  provider: string; sourceId: string; kind: 'image' | 'video'; url: string; pageUrl: string
  altUrl?: string // versão menor, tentada se a principal falhar
  description: string; color: string | null; author: string; license: string; durationS?: number
}
type Active = { provider: string; config: Record<string, string>; secrets: Record<string, string> }

// Integrações ligadas de uma categoria, por prioridade. Só valem as do próprio usuário;
// o que ele nunca mexeu segue o catálogo (as gratuitas sem chave, builtIn, vêm ligadas).
export async function activeProviders(category: IntegrationCategory, userId?: string | null): Promise<Active[]> {
  const rows = userId ? await prisma.integration.findMany({ where: { category, ownerId: userId }, include: { secrets: true } }) : []
  const list: (Active & { priority: number })[] = []
  for (const p of PROVIDERS.filter((x) => x.category === category)) {
    const row = rows.find((r) => r.provider === p.provider)
    if (row ? !row.enabled : !p.builtIn) continue
    const secrets = Object.fromEntries((row?.secrets ?? []).map((s) => [s.name, decryptSecret(s)]))
    if (p.secrets.some((n) => !secrets[n])) continue // ligada mas sem chave: não dá para usar
    list.push({ provider: p.provider, priority: row?.priority ?? p.priority, config: { ...p.config, ...(row ? JSON.parse(row.config) : {}) }, secrets })
  }
  return list.sort((a, b) => a.priority - b.priority)
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

async function pixabay(a: Active, query: string, kind: 'image' | 'video', orientation: string): Promise<StockCandidate[]> {
  const q = `key=${encodeURIComponent(a.secrets.api_key)}&q=${encodeURIComponent(query)}&per_page=5&safesearch=true`
  if (kind === 'image') {
    const d = await getJson(`https://pixabay.com/api/?${q}&image_type=photo&orientation=${orientation === 'portrait' ? 'vertical' : 'horizontal'}`)
    return d.hits.map((h: any) => ({ provider: 'pixabay', sourceId: String(h.id), kind, url: h.largeImageURL, altUrl: h.webformatURL, pageUrl: h.pageURL, description: h.tags, color: null, author: h.user, license: 'Pixabay Content License' }))
  }
  const d = await getJson(`https://pixabay.com/api/videos/?${q}`)
  return d.hits.map((h: any) => ({ provider: 'pixabay', sourceId: String(h.id), kind, url: h.videos.large.url || h.videos.medium.url, pageUrl: h.pageURL, description: h.tags, color: null, author: h.user, license: 'Pixabay Content License', durationS: h.duration }))
}

// Openverse: imagens Creative Commons, sem chave. Só licenças que permitem uso comercial e modificação.
async function openverse(_a: Active, query: string, kind: 'image' | 'video', orientation: string): Promise<StockCandidate[]> {
  if (kind === 'video') return []
  const aspect = orientation === 'portrait' ? 'tall' : orientation === 'square' ? 'square' : 'wide'
  const d = await getJson(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license_type=commercial,modification&aspect_ratio=${aspect}&size=large&page_size=5`,
    { 'User-Agent': 'Darkviews/1.0 (local)' })
  return d.results.map((r: any) => ({
    provider: 'openverse', sourceId: String(r.id), kind, url: r.url, pageUrl: r.foreign_landing_url ?? r.url, description: r.title || query,
    color: null, author: r.creator ?? 'autor desconhecido', license: `CC ${String(r.license).toUpperCase()} ${r.license_version ?? ''}`.trim(),
  }))
}

// Serper: resultados do Google Imagens. Sem licença garantida, por isso fica por último na fila.
async function serper(a: Active, query: string, kind: 'image' | 'video', orientation: string): Promise<StockCandidate[]> {
  if (kind === 'video') return []
  const res = await fetch('https://google.serper.dev/images', {
    method: 'POST', headers: { 'X-API-KEY': a.secrets.api_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, gl: 'br', hl: 'pt-br', num: 20 }), signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d = (await res.json()) as any
  const fits = (i: any) => !i.imageWidth || !i.imageHeight || (orientation === 'portrait' ? i.imageHeight >= i.imageWidth : orientation === 'square' ? true : i.imageWidth >= i.imageHeight)
  return (d.images ?? []).filter((i: any) => i.imageUrl && fits(i)).slice(0, 5).map((i: any) => ({
    provider: 'serper', sourceId: i.imageUrl, kind, url: i.imageUrl, altUrl: i.thumbnailUrl, pageUrl: i.link ?? i.imageUrl, description: i.title || query,
    color: null, author: i.source ?? i.domain ?? 'Google Imagens', license: 'Sem licença verificada',
  }))
}
// Imagens da web (DuckDuckGo, sem chave): fotos reais de pessoas e fatos. Têm dono: a licença diz isso.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
async function web(_a: Active, query: string, kind: 'image' | 'video', orientation: string): Promise<StockCandidate[]> {
  if (kind === 'video') return []
  const page = await (await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(15_000) })).text()
  const vqd = /vqd=["']?([\d-]+)/.exec(page)?.[1]
  if (!vqd) throw new Error('busca na web indisponível agora')
  const res = await fetch(`https://duckduckgo.com/i.js?l=br-pt&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,,,&p=-1`, { headers: { 'User-Agent': BROWSER_UA, Referer: 'https://duckduckgo.com/' }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d = (await res.json()) as any
  const fits = (i: any) => orientation === 'portrait' ? i.height >= i.width : orientation === 'square' ? true : i.width >= i.height * 1.1
  // Fotos grandes primeiro (as pequenas ficam borradas em 1080p).
  return (d.results ?? []).filter((i: any) => i.image && i.width >= 800 && fits(i)).slice(0, 6).map((i: any) => ({
    provider: 'web', sourceId: i.image, kind, url: i.image, altUrl: i.thumbnail, pageUrl: i.url ?? i.image, description: i.title || query,
    color: null, author: i.source || new URL(i.url ?? i.image).hostname, license: 'Direitos autorais do dono (não verificado)',
  }))
}

// Wikimedia Commons (sem chave): fotos reais de pessoas famosas, lugares e eventos, com licença livre.
async function wikimedia(_a: Active, query: string, kind: 'image' | 'video', _orientation: string): Promise<StockCandidate[]> {
  if (kind === 'video') return []
  const d = await getJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=6&gsrsearch=${encodeURIComponent(`${query} filetype:bitmap`)}&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=1920`,
    { 'User-Agent': 'Darkviews/1.0 (local video tool)' })
  return Object.values(d.query?.pages ?? {}).filter((p: any) => p.imageinfo?.[0]?.width >= 800).map((p: any) => {
    const i = p.imageinfo[0], m = i.extmetadata ?? {}
    return {
      provider: 'wikimedia', sourceId: String(p.pageid), kind, url: i.thumburl ?? i.url, altUrl: i.url, pageUrl: i.descriptionurl,
      description: String(m.ImageDescription?.value ?? p.title).replace(/<[^>]+>/g, '').slice(0, 160), color: null,
      author: String(m.Artist?.value ?? 'Wikimedia Commons').replace(/<[^>]+>/g, '').slice(0, 80), license: String(m.LicenseShortName?.value ?? 'Wikimedia Commons'),
    }
  })
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const STOCK: Record<string, typeof pixabay> = { pixabay, openverse, serper, web, wikimedia }

// Busca por níveis: os termos vêm do mais fiel (nível 1) ao mais genérico (nível 4). Para cada termo, tenta as fontes
// por prioridade (web e Wikimedia antes dos bancos de foto genérica) e para quando já tem opções suficientes.
// As opções voltam em ordem de nível: a escolha prefere a mais fiel.
export async function searchStock(queries: string[], kind: 'image' | 'video', orientation: string, userId?: string | null, levels: number[] = []) {
  const all: (StockCandidate & { level: number })[] = []
  const providers = await activeProviders('banco_de_imagens', userId)
  for (const [k, q] of queries.entries()) {
    const level = levels[k] ?? Math.min(4, k + 1)
    for (const a of providers) {
      try {
        for (const c of (await STOCK[a.provider](a, q, kind, orientation)).slice(0, 3)) if (!all.some((f) => f.url === c.url)) all.push({ ...c, level })
      } catch (e) { warn(a.provider, (e as Error).message, userId) }
    }
    if (all.length >= 8) break
  }
  return all.sort((x, y) => x.level - y.level)
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

const KOKORO_PY = process.env.KOKORO_PYTHON ?? resolve(import.meta.dirname, '../../../.venv-kokoro/bin/python')
const KOKORO_SCRIPT = resolve(import.meta.dirname, '../kokoro_tts.py')

// Kokoro: um processo para várias falas (o modelo carrega uma vez só).
async function kokoroSpeak(items: { text: string; out: string; voice: string; speed: number }[]) {
  await new Promise<void>((ok, fail) => {
    const p = execFile(KOKORO_PY, [KOKORO_SCRIPT], { timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (e) => (e ? fail(e) : ok()))
    p.stdin?.end(JSON.stringify(items))
  })
}

// Várias falas de uma vez (um vídeo inteiro). Com Kokoro como voz principal, gera todas num processo só;
// com as outras vozes, uma a uma. Fala que falhar fica de fora (o chamador decide o que fazer).
export type VoiceChoice = { provider?: string; voice?: string; speed?: number }
// A voz escolhida na criação passa para o topo da lista; as outras seguem como reserva.
// Depois dela, a reserva é a Kokoro (a que pronuncia melhor o português); Piper e macOS só no fim.
const WEAK_VOICES = ['piper', 'macos_say']
export const preferProvider = <T extends { provider: string }>(list: T[], provider?: string) => {
  const rest = list.filter((a) => a.provider !== provider)
  return [...list.filter((a) => a.provider === provider), ...rest.filter((a) => !WEAK_VOICES.includes(a.provider)), ...rest.filter((a) => WEAK_VOICES.includes(a.provider))]
}
export async function synthesizeMany(items: { key: number; text: string; outBase: string }[], ffmpeg: string, userId?: string | null, choice: VoiceChoice = {}) {
  const result = new Map<number, { path: string; provider: string }>()
  const [first] = preferProvider(await activeProviders('voz', userId), choice.provider)
  if (first && first.provider !== choice.provider) choice = { speed: choice.speed } // a voz escolhida era de outro fornecedor
  if (first?.provider === 'kokoro') {
    try {
      const voice = choice.voice || first.config.voice || 'pf_dora', speed = choice.speed ?? (Number(first.config.speed) || 1)
      await kokoroSpeak(items.map((i) => ({ text: i.text, out: i.outBase + '.kokoro.wav', voice, speed })))
      for (const i of items) {
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', i.outBase + '.kokoro.wav', '-ar', '48000', '-ac', '2', i.outBase + '.wav'])
        result.set(i.key, { path: i.outBase + '.wav', provider: 'kokoro' })
      }
      return result
    } catch (e) {
      warn('kokoro', `voz falhou, usando a próxima: ${(e as Error).message}`, userId)
    }
  }
  // A primeira voz que falar narra o vídeo todo: as cenas seguintes não trocam de voz (melhor falhar do que misturar).
  const names = (await activeProviders('voz', userId)).map((a) => a.provider)
  let locked: string | null = null
  for (const i of items) {
    const skip = locked ? names.filter((n) => n !== locked) : first?.provider === 'kokoro' ? ['kokoro'] : []
    const v = await synthesize(i.text, i.outBase, ffmpeg, userId, skip, choice)
    if (!v) throw new Error(locked ? `A voz ${locked} falhou numa cena. Clique em Tentar de novo.` : 'Nenhuma voz disponível para narrar.')
    locked = v.provider
    result.set(i.key, v)
  }
  return result
}

// Gera a fala em `outBase`.wav (48 kHz estéreo) e devolve o caminho. null = nenhuma voz disponível.
export async function synthesize(text: string, outBase: string, ffmpeg: string, userId?: string | null, skip: string[] = [], choice: VoiceChoice = {}): Promise<{ path: string; provider: string } | null> {
  const wav = outBase + '.wav'
  const toWav = (input: string) => run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-ar', '48000', '-ac', '2', wav])
  const providers = preferProvider(await activeProviders('voz', userId), choice.provider)
  for (const [n, a0] of providers.entries()) {
    if (skip.includes(a0.provider)) continue
    const a = n === 0 && (choice.voice || choice.speed) ? { ...a0, config: { ...a0.config, ...(choice.voice && { voice: choice.voice }), ...(choice.speed && { speed: String(choice.speed) }) } } : a0
    try {
      if (a.provider === 'kokoro') {
        await kokoroSpeak([{ text, out: outBase + '.kokoro.wav', voice: a.config.voice || 'pf_dora', speed: Number(a.config.speed) || 1 }])
        await toWav(outBase + '.kokoro.wav')
      } else if (a.provider === 'piper') {
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
// ---------- trilha sonora ----------
export type MusicPick = { path: string; provider: string; license: string; attribution: string }
// Só ASCII: com acento ("vídeos") os servidores recusam o pedido (403).
const UA = { 'User-Agent': 'Darkviews/1.0 (local video tool)' }
async function save(url: string, out: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers as Record<string, string>) }, signal: AbortSignal.timeout(90_000) })
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(out))
  return out
}
// Entre as opções, a de duração mais próxima acima do vídeo (curta demais repete em loop).
const byFit = <T>(list: T[], len: (x: T) => number, want: number) =>
  [...list].sort((a, b) => (len(a) >= want ? len(a) - want : 1e6 + want - len(a)) - (len(b) >= want ? len(b) - want : 1e6 + want - len(b)))
// Tenta as 3 que melhor encaixam: se um download falhar ou demorar, vai para a próxima.
async function firstOk<T>(list: T[], fn: (x: T) => Promise<MusicPick>) {
  let last: unknown
  for (const x of list.slice(0, 3)) { try { return await fn(x) } catch (e) { last = e } }
  if (last) throw last
  return null
}

type MusicFn = (a: Active, tags: string, durationS: number, outBase: string) => Promise<MusicPick | null>
const MUSIC: Record<string, MusicFn> = {
  async elevenlabs_music(a, tags, durationS, outBase) {
    const out = await save('https://api.elevenlabs.io/v1/music', outBase + '.mp3', {
      method: 'POST', headers: { 'xi-api-key': a.secrets.api_key, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: `${tags || 'calm'} instrumental background music for a YouTube video, no vocals`, music_length_ms: Math.round(Math.min(Math.max(durationS, 10), 300) * 1000) }),
    })
    return { path: out, provider: 'elevenlabs_music', license: 'ElevenLabs (uso comercial no plano pago)', attribution: 'Música: gerada com ElevenLabs' }
  },
  async jamendo(a, tags, durationS, outBase) {
    const d = await getJson(`https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(a.secrets.api_key)}&format=json&limit=30&vocalinstrumental=instrumental&audiodownload_allowed=true&fuzzytags=${encodeURIComponent(tags.replace(/\s+/g, '+') || 'background')}`)
    // Só licenças que permitem uso comercial e trilha em vídeo (sem NC e sem ND).
    const ok = (d.results as any[]).filter((t) => t.audiodownload && !/-nc|-nd/.test(String(t.license_ccurl))) // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!ok.length) return null
    return firstOk(byFit(ok, (x) => Number(x.duration), durationS), async (t) =>
      ({ path: await save(t.audiodownload, outBase + '.mp3'), provider: 'jamendo', license: String(t.license_ccurl), attribution: `Música: "${t.name}" de ${t.artist_name} (Jamendo, ${t.license_ccurl}) ${t.shareurl}` }))
  },
  async openverse_audio(_a, tags, durationS, outBase) {
    // Só Freesound: os arquivos do Jamendo listados no Openverse recusam download direto (403).
    const d = await getJson(`https://api.openverse.org/v1/audio/?q=${encodeURIComponent(`${tags || 'background'} music`)}&source=freesound&license_type=commercial,modification&page_size=20`, UA) // sem conta, o máximo é 20 (acima disso dá 401)
    const words = [...tags.split(/\s+/), 'music', 'loop', 'soundtrack', 'beat'].filter(Boolean)
    const text = (r: any) => `${r.title} ${(r.tags ?? []).map((t: any) => t.name).join(' ')}`.toLowerCase() // eslint-disable-line @typescript-eslint/no-explicit-any
    // Música de verdade (não efeito sonoro): entre 30 s e 15 min, com o estilo ou "music" no título/etiquetas.
    const ok = (d.results as any[]).filter((r) => r.url && r.duration >= 30_000 && r.duration <= 420_000 && words.some((w) => text(r).includes(w))) // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!ok.length) return null
    return firstOk(byFit(ok, (x) => Number(x.duration) / 1000, durationS), async (r) => {
      const ext = String(r.url).match(/\.(mp3|ogg|wav|flac|m4a)(\?|$)/i)?.[1] ?? 'mp3'
      const license = `CC ${String(r.license).toUpperCase()} ${r.license_version ?? ''}`.trim()
      return { path: await save(r.url, `${outBase}.${ext}`), provider: 'openverse_audio', license, attribution: `Música: "${r.title}" de ${r.creator ?? 'autor desconhecido'} (${license}) ${r.foreign_landing_url ?? r.url}` }
    })
  },
  async local_music() {
    const dir = join(STORAGE_DIR, 'music')
    const files = (await readdir(dir).catch(() => [])).filter((f) => /\.(mp3|m4a|wav)$/i.test(f))
    if (!files.length) return null
    return { path: join(dir, files[Math.floor(Math.random() * files.length)]), provider: 'local_music', license: 'biblioteca local', attribution: '' }
  },
}

// Trilha no estilo pedido, tentando as fontes de música por prioridade. tags vazio = sem trilha.
export async function pickMusic(userId: string | null | undefined, tags: string | null, durationS: number, outBase: string): Promise<MusicPick | null> {
  if (tags === '') return null
  for (const a of await activeProviders('música', userId)) {
    try {
      const m = await MUSIC[a.provider]?.(a, tags ?? 'background', durationS, outBase)
      if (m) return m
    } catch (e) { warn(a.provider, `trilha: ${(e as Error).message}`, userId) }
  }
  return null
}

// ---------- botão "Testar": chamada mínima, sem devolver a resposta bruta ----------
export async function testIntegration(provider: string, secrets: Record<string, string>, config: Record<string, string>) {
  const a: Active = { provider, secrets, config }
  try {
    if (provider === 'youtube_data') await youtubeTop(secrets.api_key, 'café')
    else if (provider === 'serper_search') await googleSearch(secrets.api_key, 'café')
    else if (provider === 'claude_web') return true
    else if (provider === 'pixabay') await pixabay(a, 'coffee', 'image', 'landscape')
    else if (provider === 'serper') { if (!(await serper(a, 'coffee', 'image', 'landscape')).length) return false }
    else if (provider === 'openverse') { if (!(await openverse(a, 'coffee', 'image', 'landscape')).length) return false }
    else if (provider === 'elevenlabs') await getJson('https://api.elevenlabs.io/v1/user', { 'xi-api-key': secrets.api_key })
    else if (provider === 'openai_tts') await getJson('https://api.openai.com/v1/models/gpt-4o-mini-tts', { authorization: `Bearer ${secrets.api_key}` })
    else if (provider === 'google_tts') await getJson(`https://texttospeech.googleapis.com/v1/voices?languageCode=pt-BR&key=${encodeURIComponent(secrets.api_key)}`)
    else if (provider === 'kokoro') { await kokoroSpeak([{ text: 'Olá.', out: join(tmpdir(), `kokoro-teste-${process.pid}.wav`), voice: config.voice || 'pf_dora', speed: 1 }]) }
    else if (provider === 'piper') { await piperModel(config.voice || 'faber'); await run(PIPER_BIN, ['--help']) }
    else if (provider === 'macos_say') await run('say', ['-v', config.voice || 'Luciana', '-o', '/dev/null', 'ok'])
    else if (provider === 'local_music') await readdir(join(STORAGE_DIR, 'music'))
    else if (provider === 'openverse_audio') await getJson('https://api.openverse.org/v1/audio/?q=lofi&category=music&page_size=1', UA)
    else if (provider === 'jamendo') { if ((await getJson(`https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(secrets.api_key)}&format=json&limit=1`)).headers?.status !== 'success') return false }
    else if (provider === 'elevenlabs_music') await getJson('https://api.elevenlabs.io/v1/user', { 'xi-api-key': secrets.api_key })
    return true
  } catch { return false }
}

// ---------- VoiceStudio (aba Vozes): perfis de voz próprios, criados ou clonados ----------
// Conversa com o servidor local do VoiceStudio por HTTP; o código dele (AGPL) não entra neste projeto.
const STUDIO = () => process.env.VOICESTUDIO_URL ?? 'http://127.0.0.1:3900'
export const STUDIO_FFMPEG = process.env.FFMPEG_PATH
  ?? (existsSync('/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg') ? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg' : 'ffmpeg')
export const STUDIO_SAMPLE_TEXT = 'Olá! Esta é a minha voz. Vou narrar os seus vídeos com calma, clareza e muita naturalidade.'
// Atributos que o modelo entende (em inglês); a tela mostra em português.
export const STUDIO_ATTRS = {
  gender: { male: 'Masculina', female: 'Feminina' },
  age: { child: 'Criança', teenager: 'Adolescente', 'young adult': 'Jovem adulta', 'middle-aged': 'Meia-idade', elderly: 'Idosa' },
  pitch: { 'very low pitch': 'Muito grave', 'low pitch': 'Grave', 'moderate pitch': 'Média', 'high pitch': 'Aguda', 'very high pitch': 'Muito aguda' },
  style: { whisper: 'Sussurrada' },
  accent: { 'portuguese accent': 'Português', 'american accent': 'Americano', 'british accent': 'Britânico' },
} as const
export type StudioAttrs = Partial<Record<keyof typeof STUDIO_ATTRS, string>>
export const studioInstruct = (a: StudioAttrs) =>
  (Object.keys(STUDIO_ATTRS) as (keyof typeof STUDIO_ATTRS)[]).map((k) => a[k]).filter((v): v is string => !!v && Object.values(STUDIO_ATTRS).some((m) => v in m)).join(', ')

export class StudioError extends Error {}
async function studioFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const res = await fetch(STUDIO() + path, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 600_000) }).catch(() => null)
  if (!res) throw new StudioError('O VoiceStudio está desligado. Ligue o VoiceStudio e tente de novo.')
  if (res.status === 403) throw new StudioError('O modelo de voz do VoiceStudio precisa da licença aceita. Abra o VoiceStudio e aceite a licença do modelo.')
  if (!res.ok) throw new StudioError(`O VoiceStudio recusou o pedido (${res.status}).`)
  return res
}

export async function studioStatus() {
  const online = await fetch(`${STUDIO()}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false)
  if (!online) return { online, licensed: false }
  const states = await Promise.all(STUDIO_MODELS.map((m) => fetch(`${STUDIO()}/models/licenses/acceptance/${m}`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null)))
  return { online, licensed: states.every((s) => s?.accepted === true) }
}

// Modelos que o VoiceStudio exige com licença aceita antes de gerar voz.
const STUDIO_MODELS = ['k2-fsa/OmniVoice', 'eustlb/higgs-audio-v2-tokenizer']
// Aceita as licenças dos modelos (só quando a pessoa clica no botão da aba Vozes).
export async function studioAcceptLicenses() {
  for (const m of STUDIO_MODELS) {
    const { fingerprint } = await (await studioFetch(`/models/licenses/acceptance/${m}`, { timeoutMs: 10_000 })).json() as { fingerprint: string }
    await studioFetch('/models/licenses/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo_id: m, fingerprint, accepted: true }), timeoutMs: 10_000 })
  }
}

// Fala gerada (WAV). Com profileId usa a voz salva; com instruct, uma voz criada pelos atributos (seed fixa = mesma voz).
export async function studioGenerate(o: { text: string; profileId?: string; instruct?: string; speed?: number }) {
  const form = new FormData()
  form.append('text', o.text); form.append('language', 'Auto'); form.append('speed', String(o.speed ?? 1)); form.append('seed', '42')
  if (o.profileId) form.append('profile_id', o.profileId)
  if (o.instruct) form.append('instruct', o.instruct)
  return Buffer.from(await (await studioFetch('/generate', { method: 'POST', body: form })).arrayBuffer())
}

export async function studioCreateProfile(name: string, wavPath: string, refText: string) {
  const { readFile } = await import('node:fs/promises')
  const form = new FormData()
  form.append('name', name); form.append('kind', 'clone'); form.append('ref_text', refText); form.append('language', 'Auto')
  form.append('ref_audio', new Blob([new Uint8Array(await readFile(wavPath))], { type: 'audio/wav' }), 'ref.wav')
  const r = await (await studioFetch('/profiles', { method: 'POST', body: form })).json() as { id: string }
  return r.id
}

export const studioDeleteProfile = (id: string) => studioFetch(`/profiles/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 10_000 }).then(() => {}, () => {})

// Qualquer áudio vira WAV mono 24 kHz de até 30 s. Se o FFmpeg não ler, não é áudio.
export async function toStudioWav(input: string, out: string) {
  try { await run(STUDIO_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-t', '12', '-vn', '-ac', '1', '-ar', '24000', out]) }
  catch { throw new StudioError('Não consegui ler esse áudio. Envie MP3, WAV, M4A ou grave de novo.') }
}

// ---------- Pesquisa e análise (Brainstorm, aba Análise) ----------
/* eslint-disable @typescript-eslint/no-explicit-any */
// Vídeos com mais visualizações do nicho no último ano.
export async function youtubeTop(apiKey: string, query: string) {
  const since = new Date(Date.now() - 365 * 86400_000).toISOString()
  const s = await getJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&maxResults=15&relevanceLanguage=pt&publishedAfter=${since}&q=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`)
  const ids = (s.items ?? []).map((i: any) => i.id.videoId).join(',')
  if (!ids) return []
  const v = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${ids}&key=${encodeURIComponent(apiKey)}`)
  return (v.items ?? []).map((i: any) => ({ title: i.snippet.title as string, channel: i.snippet.channelTitle as string, views: Number(i.statistics.viewCount ?? 0), published: String(i.snippet.publishedAt).slice(0, 10) }))
}
// Números de um vídeo do YouTube (pelo link).
export async function youtubeStats(apiKey: string, url: string) {
  const id = /(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/.exec(url)?.[1]
  if (!id) return null
  const v = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${id}&key=${encodeURIComponent(apiKey)}`)
  const i = v.items?.[0]
  return i ? { channel: i.snippet.channelTitle as string, published: String(i.snippet.publishedAt).slice(0, 10), views: Number(i.statistics.viewCount ?? 0), likes: Number(i.statistics.likeCount ?? 0), comments: Number(i.statistics.commentCount ?? 0) } : null
}
// Resultados do Google (título e trecho) sobre um assunto.
export async function googleSearch(apiKey: string, query: string) {
  const res = await fetch('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query, gl: 'br', hl: 'pt-br', num: 10 }), signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d = (await res.json()) as any
  return [...(d.organic ?? []).map((o: any) => `${o.title}: ${o.snippet ?? ''}`), ...(d.peopleAlsoAsk ?? []).map((q: any) => `Pergunta frequente: ${q.question}`)].slice(0, 14) as string[]
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// O que está ligado na aba Integrações → Pesquisa e Análise.
export async function researchKit(userId?: string | null) {
  const on = await activeProviders('pesquisa', userId)
  const key = (p: string) => on.find((a) => a.provider === p)?.secrets.api_key
  return { web: on.some((a) => a.provider === 'claude_web'), youtube: key('youtube_data'), google: key('serper_search') }
}
