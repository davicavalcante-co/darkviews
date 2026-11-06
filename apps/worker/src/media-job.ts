import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { logEvent, prisma, sniffFile, STORAGE_DIR, type Job } from '@corte/db'
import { activeProviders, searchStock, studioGenerate, synthesize, synthesizeMany, type StockCandidate } from '@corte/providers'
import { MAX_DURATION_S, VOICE_TONES, voiceKey } from '@corte/shared'
import { askClaude, ClaudeUnavailable, LIGHT_MODEL } from './claude.js'
import { durationOf, FFMPEG, run } from './ffmpeg.js'
import { clarity } from './media.js'

const MAX_DOWNLOAD = 500 * 1024 * 1024
export const INTRO_S = 3 // abertura: a cor de fundo esmaece para a 1ª imagem; a fala começa depois
export const REVIEW_MINUTES = 10 // cada rodada de aprovação de imagens tem o seu prazo

// Bancos como o Wikimedia (fonte do Openverse) exigem identificação e limitam rajadas: identifica e tenta de novo no 429.
const UA = 'Darkviews/1.0 (local video tool; https://github.com/davicavalcante-co/darkviews)' // só ASCII: acento no User-Agent dá 403
async function download(url: string, dir: string) {
  let res: Response | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5 * 60_000) })
    if (res.status !== 429 && res.status < 500) break
    await new Promise((r) => setTimeout(r, (Number(res!.headers.get('retry-after')) || 2 ** attempt * 2) * 1000))
  }
  if (!res?.ok || !res.body) throw new Error(`download HTTP ${res?.status}`)
  if (Number(res.headers.get('content-length') ?? 0) > MAX_DOWNLOAD) throw new Error('arquivo grande demais')
  const tmp = join(dir, randomUUID())
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(tmp))
  const type = await sniffFile(tmp)
  if (!type) { await rm(tmp, { force: true }); throw new Error('download não é imagem nem vídeo válido') }
  return { path: tmp, ...type }
}

const BANK_NAMES: Record<string, string> = { pixabay: 'Pixabay', openverse: 'Openverse', serper: 'Google Imagens', web: 'Web', wikimedia: 'Wikimedia Commons' }

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
    const q = JSON.parse(s.searchQuery!) as { queries: string[]; levels?: number[]; kind: 'image' | 'video'; orientation: string; rejected?: string[] }
    const rejected = new Set(q.rejected ?? [])
    found.set(s.index, (await searchStock(q.queries, q.kind, q.orientation, project.ownerId, q.levels)).filter((c) => !rejected.has(`${c.provider}:${c.sourceId}`)))
    await step('Buscando imagens', 5 + Math.round((i / Math.max(wanted.length, 1)) * 25))
  }

  // 2. O Claude escolhe, entre até 5 opções, a que combina com a cena e o perfil de estilo (uma chamada para todas).
  const pick = new Map<number, number>()
  const toChoose = [...found].filter(([, c]) => c.length > 1)
  if (toChoose.length) {
    await step('Claude escolhendo as imagens', 32)
    const style = project.reference?.styleProfile ? JSON.parse(project.reference.styleProfile) : null
    const out = await askClaude({
      jobId: job.id, cwd: dir, effort: 'low', schema: Choices, model: LIGHT_MODEL, maxTurns: 3,
      prompt: [
        'Escolha a melhor imagem para cada cena de um vídeo. Prefira a mais fiel ao que é dito: nível 1 (exato) antes do 2, do 3 e do 4. Só desça de nível se a descrição mostrar que a opção não serve. Pessoa famosa citada: a foto dela. Produto citado: a foto do próprio produto (mesma marca e modelo), nunca um parecido ou genérico. Considere também as cores.',
        style ? `Paleta e estilo desejados: ${JSON.stringify({ palette: style.palette, tone: style.tone })}` : '',
        ...toChoose.map(([idx, cands]) => {
          const s = script.scenes.find((x) => x.index === idx)!
          return `Cena ${idx}: "${s.narration ?? ''}"\n${cands.map((c, j) => `  opção ${j} (nível ${c.level ?? 4}): ${c.kind}, ${c.description}${c.color ? `, cor ${c.color}` : ''}`).join('\n')}`
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
        const file = await download(c.url, dir).catch((e) => (c.altUrl ? download(c.altUrl, dir) : Promise.reject(e)))
        const asset = await prisma.asset.create({
          data: {
            projectId: project.id, kind: file.kind === 'video' ? 'stock_video' : 'stock_image', filePath: file.path, mime: file.mime,
            sourceProvider: c.provider, sourceId: c.sourceId, license: c.license,
            attribution: `${c.kind === 'video' ? 'Vídeo' : 'Foto'}: ${c.author} (${BANK_NAMES[c.provider] ?? c.provider}, ${c.license}) ${c.pageUrl}`,
            durationS: file.kind === 'video' ? await durationOf(file.path) : null, sortOrder: idx,
          },
        })
        assetId = asset.id
        break
      } catch (e) { logEvent({ level: 'warn', source: 'worker', kind: 'integration', message: `imagem da cena ${idx} (${c.provider}): ${(e as Error).message}`, details: { jobId: job.id, projectId: project.id } }) }
    }
    await prisma.scene.update({
      where: { id: scene.id },
      data: assetId ? { assetId } : { searchQuery: JSON.stringify({ type: 'text_card', text: scene.onScreenText || '' }) },
    })
    await step('Baixando imagens', 35 + Math.round((i / Math.max(found.size, 1)) * 20))
  }

  // Cena sem imagem (download falhou ou quadro de texto vazio) nunca fica em branco: repete a imagem da cena mais próxima.
  const all = await prisma.scene.findMany({ where: { scriptId: script.id }, orderBy: { index: 'asc' } })
  const withAsset = all.filter((s) => s.assetId)
  for (const s of all.filter((x) => !x.assetId && !(x.searchQuery && JSON.parse(x.searchQuery).type === 'text_card' && JSON.parse(x.searchQuery).text?.trim()))) {
    const near = withAsset.reduce<typeof withAsset[number] | null>((b, x) => (!b || Math.abs(x.index - s.index) < Math.abs(b.index - s.index) ? x : b), null)
    if (near) await prisma.scene.update({ where: { id: s.id }, data: { assetId: near.assetId } })
  }

  // Para aqui e espera o usuário aprovar as imagens do banco (tela de Andamento). Sem imagens de banco, segue direto.
  // Só para de novo se sobrou imagem de banco sem aprovar (as aprovadas antes não voltam para a aprovação).
  const stock = (await prisma.scene.findMany({ where: { scriptId: script.id, asset: { kind: { in: ['stock_image', 'stock_video'] } } }, select: { searchQuery: true } }))
    .filter((s) => !(s.searchQuery && JSON.parse(s.searchQuery).approved === true)).length
  if (stock) {
    await prisma.project.update({ where: { id: project.id }, data: { status: 'image_review', reviewUntil: new Date(Date.now() + REVIEW_MINUTES * 60_000) } })
  } else {
    await prisma.job.create({ data: { projectId: project.id, type: 'voice', stage: 'Na fila' } })
  }
}

// Depois das imagens aprovadas: locução, tempo das cenas, trilha e render.
export async function voice(job: Job) {
  const project = await prisma.project.update({
    where: { id: job.projectId }, data: { status: 'media' },
    include: { scripts: { orderBy: { version: 'desc' }, take: 1 } },
  })
  const script = project.scripts[0]
  if (!script) throw new Error('Projeto sem roteiro')
  const dir = join(STORAGE_DIR, 'media', project.id)
  await mkdir(dir, { recursive: true })
  const step = (stage: string, progress: number) => prisma.job.update({ where: { id: job.id }, data: { stage, progress } })

  // 4. Locução por cena; a cena cresce se a fala for mais longa que o planejado.
  const scenes = await prisma.scene.findMany({ where: { scriptId: script.id }, orderBy: { index: 'asc' } })
  await prisma.asset.deleteMany({ where: { projectId: project.id, kind: 'voice' } })
  // voicePreset vem como "fornecedor:voz" (ex.: "piper:faber"); o fornecedor escolhido vai para o topo.
  const opts = JSON.parse(project.options) as { voiceBrief?: string; voicePreset?: string; voiceTone?: string }
  const [chosenProvider, chosenVoice] = opts.voicePreset?.includes(':') ? opts.voicePreset.split(/:(.*)/s) : [undefined, opts.voicePreset]
  const directed = new Map<number, string>()
  let own: { name: string; profileId: string | null; speed: number } | null = null

  // Voz própria (aba Vozes): narra cada cena no VoiceStudio. Cena que falhar cai para a próxima voz da lista.
  if (chosenProvider === 'studio') {
    own = await prisma.studioVoice.findFirst({ where: { id: chosenVoice, ownerId: project.ownerId } })
    // A voz escolhida narra o vídeo inteiro: sem ela, para (nunca troca por outra voz no meio).
    if (!own?.profileId) throw new Error('A voz escolhida não existe mais. Escolha outra voz no Novo vídeo ou no editor.')
    const todo = scenes.filter((x) => x.narration?.trim())
    const started = Date.now()
    for (const [n, s] of todo.entries()) {
      // Mostra cena por cena (a voz própria leva ~10-25 s por cena) e o tempo que falta.
      const left = n ? Math.round(((Date.now() - started) / n) * (todo.length - n) / 1000) : null
      await prisma.job.update({ where: { id: job.id }, data: { stage: `Narrando com a sua voz "${own.name}" · cena ${n + 1} de ${todo.length}`, progress: 55 + Math.round((n / todo.length) * 35), etaS: left } })
      // Mesmo texto, voz e velocidade = mesmo arquivo: se o worker reiniciar, as cenas já narradas não são refeitas.
      const key = createHash('sha1').update(`${own.profileId}|${own.speed}|${s.narration}`).digest('hex').slice(0, 16)
      const out = join(dir, `voz-propria-${key}`)
      // Falha passageira (ex.: o Mac sem memória livre): espera e tenta de novo, até 6 vezes. Demora mais, mas a voz não muda.
      for (let attempt = 1; !existsSync(out + '.wav'); attempt++) {
        try {
          await writeFile(out + '.studio.wav', await studioGenerate({ text: s.narration!, profileId: own.profileId, speed: own.speed }))
          await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', out + '.studio.wav', '-ar', '48000', '-ac', '2', out + '.wav'])
        } catch (e) {
          logEvent({ level: 'warn', source: 'worker', kind: 'integration', message: `voz própria falhou na cena ${s.index} (tentativa ${attempt} de 6): ${(e as Error).message}`, details: { jobId: job.id } })
          if (attempt >= 6) throw new Error(`A sua voz não conseguiu narrar a cena ${s.index + 1}: ${(e as Error).message} Feche outros programas (o VoiceStudio precisa de memória livre) e clique em Tentar de novo: as cenas já narradas são aproveitadas.`)
          await prisma.job.update({ where: { id: job.id }, data: { stage: `Narrando com a sua voz "${own.name}" · cena ${n + 1} de ${todo.length} · tentando de novo (${attempt + 1} de 6)` } })
          await new Promise((r) => setTimeout(r, attempt * 15_000))
        }
      }
      directed.set(s.index, out + '.wav')
    }
  }

  // Todas as falas de uma vez (Kokoro carrega o modelo uma vez só); o que a voz própria já narrou é reaproveitado.
  await step('Narração com a voz escolhida', 60)
  const bases = new Map(scenes.map((s) => [s.index, join(dir, `voz-${s.index}-${randomUUID().slice(0, 8)}`)]))
  const todo = scenes.filter((s) => s.narration?.trim() && !directed.has(s.index))
  const tone = VOICE_TONES.find((t) => t.id === opts.voiceTone)
  // Vídeo grande: narra em partes de ~3 min (sem cortar cena no meio), salva cada parte e passa para a próxima.
  const parts: (typeof todo)[] = [[]]
  let partS = 0
  for (const s of todo) {
    const est = s.narration!.length / 14 // ~14 caracteres por segundo de fala
    if (partS + est > 180 && parts.at(-1)!.length) { parts.push([]); partS = 0 }
    parts.at(-1)!.push(s); partS += est
  }
  const made = new Map<number, { path: string; provider: string }>()
  for (const [n, part] of parts.entries()) {
    await step(parts.length > 1 ? `Narração com a voz escolhida · parte ${n + 1} de ${parts.length}` : 'Narração com a voz escolhida', 60 + Math.round((n / parts.length) * 20))
    const got = await synthesizeMany(part.map((s) => ({ key: s.index, text: s.narration!, outBase: bases.get(s.index)! })), FFMPEG, project.ownerId,
      { provider: chosenProvider, voice: chosenVoice, speed: tone?.speed })
    for (const [k, v] of got) made.set(k, v)
  }
  for (const [idx, file] of directed) made.set(idx, { path: file, provider: 'studio' })

  // Fala clara: o Whisper ouve cada cena e compara com o texto. Pouco clara, gera de novo com a MESMA voz (até 2 vezes)
  // e fica com a melhor. Kokoro e Piper sempre geram igual, então nelas só confere e avisa.
  const spoken = scenes.filter((s) => made.has(s.index) && s.narration?.trim())
  const others = (await activeProviders('voz', project.ownerId)).map((a) => a.provider)
  for (const [n, s] of spoken.entries()) {
    let best = made.get(s.index)!
    let score = await clarity(best.path, s.narration!)
    if (score === null) break // Whisper não instalado: segue sem conferir
    await prisma.job.update({ where: { id: job.id }, data: { stage: `Conferindo se a fala ficou clara · cena ${n + 1} de ${spoken.length}` } })
    const random = ['studio', 'elevenlabs', 'openai_tts'].includes(best.provider)
    for (let attempt = 1; random && score < 0.7 && attempt <= 2; attempt++) {
      const base = `${bases.get(s.index)}-clareza${attempt}`
      let file: string | null = null
      if (best.provider === 'studio' && own?.profileId) {
        await writeFile(base + '.studio.wav', await studioGenerate({ text: s.narration!, profileId: own.profileId, speed: own.speed, seed: 42 + attempt }))
        await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', base + '.studio.wav', '-ar', '48000', '-ac', '2', base + '.wav'])
        file = base + '.wav'
      } else if (best.provider !== 'studio') {
        file = (await synthesize(s.narration!, base, FFMPEG, project.ownerId, others.filter((o) => o !== best.provider), { provider: chosenProvider, voice: chosenVoice, speed: tone?.speed }))?.path ?? null
      }
      const again = file ? await clarity(file, s.narration!) : null
      if (file && again !== null && again > score) { best = { path: file, provider: best.provider }; score = again }
    }
    made.set(s.index, best)
    if (score < 0.7) logEvent({ level: 'warn', source: 'worker', kind: 'job', message: `cena ${s.index + 1}: fala pode estar pouco clara (${Math.round(score * 100)}% das palavras reconhecidas)`, details: { jobId: job.id, projectId: project.id } })
  }

  // Pausas estratégicas: respiro curto depois de cada fala e uma pausa maior quando começa um novo contexto
  // (quadro de título/capítulo ou cena com texto de tela), para o espectador sentir a virada.
  const isNewContext = (s: (typeof scenes)[number]) => !!s.onScreenText || (s.searchQuery ? JSON.parse(s.searchQuery).type === 'text_card' : false)
  let t = 0
  const cardRow = await prisma.setting.findUnique({ where: { key: `card_duration:${project.ownerId}` } })
  const cardDefault = cardRow ? Number(cardRow.value) : null
  for (const [i, s] of scenes.entries()) {
    await step('Narração com a voz escolhida', 60 + Math.round((i / scenes.length) * 35))
    const next = scenes[i + 1]
    // Ritmo de YouTube: respiro curto entre falas e um pouco mais só na virada de capítulo.
    const lead = i === 0 ? INTRO_S : isNewContext(s) ? 0.25 : 0.05
    const tail = next && isNewContext(next) ? 0.4 : 0.18
    // Cena sem fala (cartela): a duração padrão da pessoa, se ela definiu uma; senão 3 s (+ a abertura, se for a primeira).
    let dur = s.narration?.trim() ? s.endS - s.startS : (cardDefault ?? 3) + (i === 0 ? INTRO_S : 0)
    const v = made.get(s.index)
    if (v) {
      // A fala vira um WAV com o silêncio de entrada e de saída já embutidos (fade curto para não "estalar").
      const out = bases.get(s.index)! + '.final.wav'
      await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', v.path, '-af',
        // Corta só o silêncio do FIM (cortar o do começo comia a 1ª sílaba: "Em Assis" virava "sis"). O volume é igualado no render.
        `areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse,adelay=${Math.round(lead * 1000)}:all=1,apad=pad_dur=${tail}`, '-ar', '48000', '-ac', '2', out])
      dur = await durationOf(out)
      await prisma.asset.create({ data: { projectId: project.id, kind: 'voice', filePath: out, mime: 'audio/wav', durationS: dur, sourceProvider: v.provider, sortOrder: s.index } })
    }
    await prisma.scene.update({ where: { id: s.id }, data: { startS: t, endS: t + dur } })
    t += dur
  }
  if (t > MAX_DURATION_S) throw new Error(`Com a locução o vídeo ficou com ${Math.round(t)}s, acima de 18 minutos. Encurte o roteiro.`)

  // A trilha não entra na criação: é escolhida no editor e buscada no render.

  // Guarda com qual voz/ritmo a narração foi feita: o render compara com a escolha atual e narra de novo se mudou.
  const fresh = JSON.parse((await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { options: true } })).options)
  await prisma.project.update({ where: { id: project.id }, data: { status: 'rendering', options: JSON.stringify({ ...fresh, voicedWith: voiceKey(opts) }) } })
  await prisma.job.create({ data: { projectId: project.id, type: 'render', stage: 'Na fila' } })
}
