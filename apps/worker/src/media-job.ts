import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { logEvent, prisma, sniffFile, STORAGE_DIR, type Job } from '@corte/db'
import { activeProviders, pickMusic, searchStock, synthesize, type StockCandidate } from '@corte/providers'
import { MAX_DURATION_S } from '@corte/shared'
import { askClaude, ClaudeUnavailable } from './claude.js'
import { ensureOmniVoice, narrateWithClaude } from './omnivoice.js'
import { durationOf, FFMPEG, run } from './ffmpeg.js'

const MAX_DOWNLOAD = 500 * 1024 * 1024

async function download(url: string, dir: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) })
  if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`)
  if (Number(res.headers.get('content-length') ?? 0) > MAX_DOWNLOAD) throw new Error('arquivo grande demais')
  const tmp = join(dir, randomUUID())
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(tmp))
  const type = await sniffFile(tmp)
  if (!type) { await rm(tmp, { force: true }); throw new Error('download não é imagem nem vídeo válido') }
  return { path: tmp, ...type }
}

const Choices = z.object({ choices: z.array(z.object({ scene: z.number().int(), candidate: z.number().int().min(0) })) })

export async function media(job: Job) {
  const project = await prisma.project.update({
    where: { id: job.projectId }, data: { status: 'media' },
    include: { reference: true, scripts: { orderBy: { version: 'desc' }, take: 1, include: { scenes: { orderBy: { index: 'asc' } } } } },
  })
  const script = project.scripts[0]
  if (!script) throw new Error('Projeto sem roteiro')
  const dir = join(STORAGE_DIR, 'media', project.id)
  await mkdir(dir, { recursive: true })
  const step = (stage: string, progress: number) => prisma.job.update({ where: { id: job.id }, data: { stage, progress } })

  // 1. Busca nos bancos (por prioridade) para cada cena que pede banco.
  await step('Buscando imagens', 5)
  const wanted = script.scenes.filter((s) => !s.assetId && s.searchQuery && JSON.parse(s.searchQuery).type === 'stock')
  const found = new Map<number, StockCandidate[]>()
  for (const [i, s] of wanted.entries()) {
    const q = JSON.parse(s.searchQuery!)
    found.set(s.index, await searchStock(q.queries, q.kind, q.orientation, project.ownerId))
    await step('Buscando imagens', 5 + Math.round((i / Math.max(wanted.length, 1)) * 25))
  }

  // 2. O Claude escolhe, entre até 5 opções, a que combina com a cena e o perfil de estilo (uma chamada para todas).
  const pick = new Map<number, number>()
  const toChoose = [...found].filter(([, c]) => c.length > 1)
  if (toChoose.length) {
    await step('Claude escolhendo as imagens', 32)
    const style = project.reference?.styleProfile ? JSON.parse(project.reference.styleProfile) : null
    const out = await askClaude({
      jobId: job.id, cwd: dir, effort: 'low', schema: Choices,
      prompt: [
        'Escolha a melhor opção de banco de imagens para cada cena de um vídeo. Considere o texto da cena, a descrição de cada opção e as cores.',
        style ? `Paleta e estilo desejados: ${JSON.stringify({ palette: style.palette, tone: style.tone })}` : '',
        ...toChoose.map(([idx, cands]) => {
          const s = script.scenes.find((x) => x.index === idx)!
          return `Cena ${idx}: "${s.narration ?? ''}"\n${cands.map((c, j) => `  opção ${j}: ${c.kind}, ${c.description}${c.color ? `, cor ${c.color}` : ''}`).join('\n')}`
        }),
      ].join('\n\n'),
    })
    for (const c of out.choices) pick.set(c.scene, c.candidate)
  }

  // 3. Baixa a escolhida; guarda licença e crédito. Se falhar, a cena vira quadro de texto.
  for (const [i, [idx, cands]] of [...found].entries()) {
    const scene = script.scenes.find((x) => x.index === idx)!
    const order = [pick.get(idx) ?? 0, ...cands.keys()].filter((v, k, a) => v < cands.length && a.indexOf(v) === k)
    let assetId: string | null = null
    for (const ci of order) {
      const c = cands[ci]
      try {
        const file = await download(c.url, dir)
        const asset = await prisma.asset.create({
          data: {
            projectId: project.id, kind: file.kind === 'video' ? 'stock_video' : 'stock_image', filePath: file.path, mime: file.mime,
            sourceProvider: c.provider, sourceId: c.sourceId, license: c.license,
            attribution: `${c.kind === 'video' ? 'Vídeo' : 'Foto'}: ${c.author} (${c.provider === 'pexels' ? 'Pexels' : 'Pixabay'}) ${c.pageUrl}`,
            durationS: file.kind === 'video' ? await durationOf(file.path) : null, sortOrder: idx,
          },
        })
        assetId = asset.id
        break
      } catch (e) { console.warn(`[media] cena ${idx}: ${(e as Error).message}`) }
    }
    await prisma.scene.update({
      where: { id: scene.id },
      data: assetId ? { assetId } : { searchQuery: JSON.stringify({ type: 'text_card', text: scene.onScreenText || '' }) },
    })
    await step('Baixando imagens', 35 + Math.round((i / Math.max(found.size, 1)) * 20))
  }

  // 4. Locução por cena; a cena cresce se a fala for mais longa que o planejado.
  const scenes = await prisma.scene.findMany({ where: { scriptId: script.id }, orderBy: { index: 'asc' } })
  await prisma.asset.deleteMany({ where: { projectId: project.id, kind: { in: ['voice', 'music'] } } })
  // Se a voz escolhida for o OmniVoice, a narração inteira passa pelo Claude Code (skill omnivoice + MCP).
  // Cena que ele não entregar cai para a próxima voz da lista (Piper, depois macOS).
  const voices = await activeProviders('voz', project.ownerId)
  let directed = new Map<number, string>()
  if (voices[0]?.provider === 'omnivoice') {
    await step('Claude Code criando a voz (OmniVoice)', 55)
    if (await ensureOmniVoice()) {
      const opts = JSON.parse(project.options) as { voiceBrief?: string }
      directed = await narrateWithClaude({
        jobId: job.id, projectId: project.id, dir, brief: opts.voiceBrief ?? null, steps: voices[0].config.steps || '16', speed: voices[0].config.speed || '1.0',
        scenes: scenes.filter((s) => s.narration?.trim()).map((s) => ({ index: s.index, text: s.narration! })),
      }).catch((e) => {
        if (e instanceof ClaudeUnavailable) throw e
        logEvent({ level: 'warn', source: 'worker', kind: 'integration', message: `omnivoice via Claude Code falhou: ${(e as Error).message}`, details: { jobId: job.id } })
        return new Map<number, string>()
      })
    } else {
      logEvent({ level: 'warn', source: 'worker', kind: 'integration', message: 'omnivoice: servidor local indisponível, usando a próxima voz', details: { jobId: job.id } })
    }
  }

  let t = 0
  for (const [i, s] of scenes.entries()) {
    await step('Gerando áudio da locução', 55 + Math.round((i / scenes.length) * 40))
    let speechS = 0
    if (s.narration?.trim()) {
      const base = join(dir, `voz-${s.index}-${randomUUID().slice(0, 8)}`)
      const fromClaude = directed.get(s.index)
      const voice = fromClaude
        ? await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', fromClaude, '-ar', '48000', '-ac', '2', base + '.wav']).then(() => ({ path: base + '.wav', provider: 'omnivoice' }))
        : await synthesize(s.narration, base, FFMPEG, project.ownerId)
      if (voice) {
        speechS = await durationOf(voice.path)
        await prisma.asset.create({ data: { projectId: project.id, kind: 'voice', filePath: voice.path, mime: 'audio/wav', durationS: speechS, sourceProvider: voice.provider, sortOrder: s.index } })
      }
    }
    // A cena acompanha a fala (mais um respiro curto). Esperar o tempo planejado deixava silêncios entre as frases.
    const dur = speechS > 0 ? speechS + 0.25 : s.endS - s.startS
    await prisma.scene.update({ where: { id: s.id }, data: { startS: t, endS: t + dur } })
    t += dur
  }
  if (t > MAX_DURATION_S) throw new Error(`Com a locução o vídeo ficou com ${Math.round(t)}s, acima de 18 minutos. Encurte o roteiro.`)

  // 5. Trilha de fundo (opcional).
  await step('Gerando áudio da trilha', 96)
  const music = await pickMusic(project.ownerId)
  if (music) await prisma.asset.create({ data: { projectId: project.id, kind: 'music', filePath: music, mime: 'audio/mpeg', sourceProvider: 'local_music', license: 'biblioteca local' } })

  await prisma.project.update({ where: { id: project.id }, data: { status: 'rendering' } })
  await prisma.job.create({ data: { projectId: project.id, type: 'render', stage: 'Na fila' } })
}
