import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { decryptSecret, prisma, STORAGE_DIR } from '@corte/db'
import { PROVIDERS, type IntegrationCategory } from '@corte/shared'

const run = promisify(execFile)

export type StockCandidate = {
  provider: string; sourceId: string; kind: 'image' | 'video'; url: string; pageUrl: string
  description: string; color: string | null; author: string; license: string; durationS?: number
}
type Active = { provider: string; config: Record<string, string>; secrets: Record<string, string> }

// Integrações ligadas de uma categoria, por prioridade. As locais (builtIn) valem ligadas até o admin desligar.
export async function activeProviders(category: IntegrationCategory): Promise<Active[]> {
  const rows = await prisma.integration.findMany({ where: { category }, include: { secrets: true } })
  const list: (Active & { priority: number })[] = []
  for (const p of PROVIDERS.filter((x) => x.category === category)) {
    const row = rows.find((r) => r.provider === p.provider)
    if (row ? !row.enabled : !p.builtIn) continue
    list.push({
      provider: p.provider,
      priority: row?.priority ?? 50,
      config: { ...p.config, ...(row ? JSON.parse(row.config) : {}) },
      secrets: Object.fromEntries((row?.secrets ?? []).map((s) => [s.name, decryptSecret(s)])),
    })
  }
  return list.sort((a, b) => a.priority - b.priority)
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ---------- bancos de imagens ----------
async function pexels(a: Active, query: string, kind: 'image' | 'video', orientation: string): Promise<StockCandidate[]> {
  const h = { Authorization: a.secrets.api_key }
  const q = `query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=5`
  if (kind === 'image') {
    const d = await getJson(`https://api.pexels.com/v1/search?${q}`, h)
    return d.photos.map((p: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      provider: 'pexels', sourceId: String(p.id), kind, url: p.src.original, pageUrl: p.url, description: p.alt || query,
      color: p.avg_color, author: p.photographer, license: 'Pexels License',
    }))
  }
  const d = await getJson(`https://api.pexels.com/videos/search?${q}`, h)
  return d.videos.flatMap((v: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const files = v.video_files.filter((f: any) => f.file_type === 'video/mp4' && f.width) // eslint-disable-line @typescript-eslint/no-explicit-any
      .sort((x: any, y: any) => Math.abs(x.width - 1920) - Math.abs(y.width - 1920)) // eslint-disable-line @typescript-eslint/no-explicit-any
    return files[0] ? [{
      provider: 'pexels', sourceId: String(v.id), kind, url: files[0].link, pageUrl: v.url, description: query,
      color: null, author: v.user?.name ?? 'Pexels', license: 'Pexels License', durationS: v.duration,
    }] : []
  })
}

async function pixabay(a: Active, query: string, kind: 'image' | 'video', orientation: string): Promise<StockCandidate[]> {
  const q = `key=${encodeURIComponent(a.secrets.api_key)}&q=${encodeURIComponent(query)}&per_page=5&safesearch=true`
  if (kind === 'image') {
    const o = orientation === 'portrait' ? 'vertical' : 'horizontal'
    const d = await getJson(`https://pixabay.com/api/?${q}&image_type=photo&orientation=${o}`)
    return d.hits.map((h: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      provider: 'pixabay', sourceId: String(h.id), kind, url: h.largeImageURL, pageUrl: h.pageURL, description: h.tags,
      color: null, author: h.user, license: 'Pixabay Content License',
    }))
  }
  const d = await getJson(`https://pixabay.com/api/videos/?${q}`)
  return d.hits.map((h: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
    provider: 'pixabay', sourceId: String(h.id), kind, url: h.videos.large.url || h.videos.medium.url, pageUrl: h.pageURL,
    description: h.tags, color: null, author: h.user, license: 'Pixabay Content License', durationS: h.duration,
  }))
}

const STOCK = { pexels, pixabay } as Record<string, typeof pexels>

// Tenta cada banco por prioridade; se um falhar ou estourar a cota, vai para o próximo.
export async function searchStock(queries: string[], kind: 'image' | 'video', orientation: string) {
  for (const a of await activeProviders('banco_de_imagens')) {
    try {
      const found: StockCandidate[] = []
      for (const q of queries) {
        for (const c of await STOCK[a.provider](a, q, kind, orientation)) if (!found.some((f) => f.sourceId === c.sourceId)) found.push(c)
        if (found.length >= 5) break
      }
      if (found.length) return found.slice(0, 5)
    } catch (e) {
      console.warn(`[providers] ${a.provider} falhou: ${(e as Error).message}`)
    }
  }
  return []
}

// ---------- voz ----------
// Gera a fala em `outBase`.wav e devolve o caminho. null = nenhuma voz disponível.
export async function synthesize(text: string, outBase: string, ffmpeg: string): Promise<{ path: string; provider: string } | null> {
  for (const a of await activeProviders('voz')) {
    try {
      const wav = outBase + '.wav'
      if (a.provider === 'elevenlabs') {
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(a.config.voice_id)}?output_format=mp3_44100_128`, {
          method: 'POST', signal: AbortSignal.timeout(120_000),
          headers: { 'xi-api-key': a.secrets.api_key, 'content-type': 'application/json' },
          body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const mp3 = outBase + '.mp3'
        await (await import('node:fs/promises')).writeFile(mp3, Buffer.from(await res.arrayBuffer()))
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', mp3, '-ar', '48000', '-ac', '2', wav])
      } else if (a.provider === 'macos_say') {
        const aiff = outBase + '.aiff'
        await run('say', ['-v', a.config.voice || 'Luciana', '-o', aiff, '--', text])
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-ar', '48000', '-ac', '2', wav])
      } else continue
      return { path: wav, provider: a.provider }
    } catch (e) {
      console.warn(`[providers] voz ${a.provider} falhou: ${(e as Error).message}`)
    }
  }
  return null
}

// ---------- música ----------
export async function pickMusic(): Promise<string | null> {
  if (!(await activeProviders('música')).some((a) => a.provider === 'local_music')) return null
  const dir = join(STORAGE_DIR, 'music')
  const files = (await readdir(dir).catch(() => [])).filter((f) => /\.(mp3|m4a|wav)$/i.test(f))
  return files.length ? join(dir, files[Math.floor(Math.random() * files.length)]) : null
}

// ---------- botão "Testar" do admin: chamada mínima, sem devolver a resposta bruta ----------
export async function testIntegration(provider: string, secrets: Record<string, string>, config: Record<string, string>) {
  const a: Active = { provider, secrets, config }
  try {
    if (provider === 'pexels') await pexels(a, 'coffee', 'image', 'landscape')
    else if (provider === 'pixabay') await pixabay(a, 'coffee', 'image', 'landscape')
    else if (provider === 'elevenlabs') await getJson('https://api.elevenlabs.io/v1/user', { 'xi-api-key': secrets.api_key })
    else if (provider === 'macos_say') await run('say', ['-v', config.voice || 'Luciana', '-o', '/dev/null', 'ok'])
    else if (provider === 'local_music') await readdir(join(STORAGE_DIR, 'music'))
    return true
  } catch { return false }
}
