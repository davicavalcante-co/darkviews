import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { logEvent, prisma, projectDir, sniffFile, type Job } from '@corte/db'
import { activeProviders, searchStock, studioGenerate, synthesize, synthesizeMany, type StockCandidate } from '@corte/providers'
import { MAX_DURATION_S, quoteStages, VOICE_TONES, voiceKey } from '@corte/shared'
import { askClaude, ClaudeUnavailable, LIGHT_MODEL } from './claude.js'
import { durationOf, FFMPEG, run } from './ffmpeg.js'
import { clarity } from './media.js'
import { checkCancel } from './cancel.js'

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
  // Só imagens / só vídeos: o banco busca só esse tipo, seja o que o roteiro pediu.
  const mediaMode = (JSON.parse(project.options) as { mediaMode?: string }).mediaMode
  const dir = await projectDir(project.id, 'midia')
  const step = async (stage: string, progress: number) => { await checkCancel(job.id); await prisma.job.update({ where: { id: job.id }, data: { stage, progress } }) }

  // 1. Busca nos bancos (por prioridade) para cada cena que pede banco.
  await step('Buscando imagens', 5)
  const wanted = script.scenes.filter((s) => !s.assetId && s.searchQuery && JSON.parse(s.searchQuery).type === 'stock')
  const found = new Map<number, StockCandidate[]>()
  for (const [i, s] of wanted.entries()) {
    const q = JSON.parse(s.searchQuery!) as { queries: string[]; levels?: number[]; kind: 'image' | 'video'; orientation: string; rejected?: string[] }
    const rejected = new Set(q.rejected ?? [])
    found.set(s.index, (await searchStock(q.queries, mediaMode === 'images' ? 'image' : mediaMode === 'videos' ? 'video' : q.kind, q.orientation, project.ownerId, q.levels)).filter((c) => !rejected.has(`${c.provider}:${c.sourceId}`)))
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
  const dir = await projectDir(project.id, 'narracao')
  await mkdir(dir, { recursive: true })
  const step = async (stage: string, progress: number) => { await checkCancel(job.id); await prisma.job.update({ where: { id: job.id }, data: { stage, progress } }) }

  // 4. Locução; a cena cresce se a fala for mais longa que o planejado.
  const scenes = await prisma.scene.findMany({ where: { scriptId: script.id }, orderBy: { index: 'asc' } })
  await prisma.asset.deleteMany({ where: { projectId: project.id, kind: 'voice' } })
  // voicePreset vem como "fornecedor:voz" (ex.: "piper:faber"); o fornecedor escolhido vai para o topo.
  const opts = JSON.parse(project.options) as { voiceBrief?: string; voicePreset?: string; voiceTone?: string }
  const [chosenProvider, chosenVoice] = opts.voicePreset?.includes(':') ? opts.voicePreset.split(/:(.*)/s) : [undefined, opts.voicePreset]
  const directed = new Map<number, string>()
  // A voz sintética às vezes engole a 1ª palavra: começar com "..." dá um respiro antes dela (não aparece na legenda).
  const say = (t: string) => `... ${t.trim()}`
  let own: { name: string; profileId: string | null; speed: number } | null = null

  // Frase inteira por áudio: cenas seguidas são narradas juntas até a frase terminar (a voz não pausa no meio dela).
  // Depois o áudio é dividido de volta entre as cenas, emendado, sem silêncio entre elas.
  type S = (typeof scenes)[number]
  const groups: S[][] = []
  for (const [i, s] of scenes.entries()) {
    if (!s.narration?.trim() || s.searchQuery?.includes('"type":"quote"')) continue // fala com corte usa o áudio original
    const g = groups.at(-1), last = g?.at(-1)
    if (g && last && scenes[i - 1] === last && !endsSentence(last.narration!)) g.push(s)
    else groups.push([s])
  }
  const textOf = (g: S[]) => g.map((s) => s.narration!.trim()).join(' ')

  // Voz própria (aba Vozes): narra cada frase no VoiceStudio.
  if (chosenProvider === 'studio') {
    own = await prisma.studioVoice.findFirst({ where: { id: chosenVoice, ownerId: project.ownerId } })
    // A voz escolhida narra o vídeo inteiro: sem ela, para (nunca troca por outra voz no meio).
    if (!own?.profileId) throw new Error('A voz escolhida não existe mais. Escolha outra voz no Novo vídeo ou no editor.')
    const started = Date.now()
    for (const [n, g] of groups.entries()) {
      // Mostra parte por parte (a voz própria leva ~10-25 s cada) e o tempo que falta.
      const left = n ? Math.round(((Date.now() - started) / n) * (groups.length - n) / 1000) : null
      await checkCancel(job.id)
      await prisma.job.update({ where: { id: job.id }, data: { stage: `Narrando com a sua voz "${own.name}" · frase ${n + 1} de ${groups.length}`, progress: 55 + Math.round((n / groups.length) * 35), etaS: left } })
      // Mesmo texto, voz e velocidade = mesmo arquivo: se o worker reiniciar, o que já foi narrado não é refeito.
      const key = createHash('sha1').update(`${own.profileId}|${own.speed}|${say(textOf(g))}`).digest('hex').slice(0, 16)
      const out = join(dir, `voz-propria-${key}`)
      // Falha passageira (ex.: o Mac sem memória livre): espera e tenta de novo, até 6 vezes. Demora mais, mas a voz não muda.
      for (let attempt = 1; !existsSync(out + '.wav'); attempt++) {
        try {
          await writeFile(out + '.studio.wav', await studioGenerate({ text: say(textOf(g)), profileId: own.profileId, speed: own.speed }))
          await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', out + '.studio.wav', '-ar', '48000', '-ac', '2', out + '.wav'])
        } catch (e) {
          logEvent({ level: 'warn', source: 'worker', kind: 'integration', message: `voz própria falhou na cena ${g[0].index} (tentativa ${attempt} de 6): ${(e as Error).message}`, details: { jobId: job.id } })
          if (attempt >= 6) throw new Error(`A sua voz não conseguiu narrar a cena ${g[0].index + 1}: ${(e as Error).message} Feche outros programas (o VoiceStudio precisa de memória livre) e clique em Tentar de novo: as cenas já narradas são aproveitadas.`)
          await prisma.job.update({ where: { id: job.id }, data: { stage: `Narrando com a sua voz "${own.name}" · frase ${n + 1} de ${groups.length} · tentando de novo (${attempt + 1} de 6)` } })
          await new Promise((r) => setTimeout(r, attempt * 15_000))
        }
      }
      directed.set(g[0].index, out + '.wav')
    }
  }

  // Todas as falas de uma vez (Kokoro carrega o modelo uma vez só); o que a voz própria já narrou é reaproveitado.
  await step('Narração com a voz escolhida', 60)
  const bases = new Map(scenes.map((s) => [s.index, join(dir, `voz-${s.index}-${randomUUID().slice(0, 8)}`)]))
  // Vídeo com falas: a cena da fala usa o áudio do corte enviado (sem gerar voz).
  const clips = await prisma.asset.findMany({ where: { projectId: project.id, kind: 'quote_video' } })
  const quoteOf = (s: S) => clips.find((c) => c.id === s.assetId)
  for (const s of scenes) {
    const c = quoteOf(s)
    if (!c) continue
    const out = join(dir, `fala-${s.index}.wav`)
    // O corte entra inteiro: o áudio dele como está (só esmaece no fim). Corte sem som: silêncio do mesmo tamanho.
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', c.filePath, '-vn', '-af', 'areverse,afade=t=in:d=0.6,areverse', '-ar', '48000', '-ac', '2', out])
      .catch(async () => run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(await durationOf(c.filePath)), out]))
    directed.set(s.index, out)
  }
  const todo = groups.filter((g) => !directed.has(g[0].index))
  const tone = VOICE_TONES.find((t) => t.id === opts.voiceTone)
  // Vídeo grande: narra em partes de ~3 min (sempre no fim de uma frase), salva cada parte e passa para a próxima.
  // Vídeo com falas: cada parte é uma etapa do narrador (até o próximo corte de fala).
  const parts: (typeof todo)[] = [[]]
  let partS = 0
  const stageOf = new Map(quoteStages(scenes).flatMap((st, k) => Array.from({ length: st.last - st.first + 1 }, (_, j) => [st.first + j, k] as [number, number])))
  for (const g of todo) {
    const est = textOf(g).length / 14 // ~14 caracteres por segundo de fala
    const newStage = clips.length > 0 && parts.at(-1)!.length > 0 && stageOf.get(parts.at(-1)!.at(-1)![0].index) !== stageOf.get(g[0].index)
    if ((partS + est > 180 || newStage) && parts.at(-1)!.length) { parts.push([]); partS = 0 }
    parts.at(-1)!.push(g); partS += est
  }
  const made = new Map<number, { path: string; provider: string }>()
  for (const [n, part] of parts.entries()) {
    await step(parts.length > 1 ? clips.length ? `Narração · etapa do narrador ${n + 1} de ${parts.length}` : `Narração com a voz escolhida · parte ${n + 1} de ${parts.length}` : 'Narração com a voz escolhida', 60 + Math.round((n / parts.length) * 20))
    const got = await synthesizeMany(part.map((g) => ({ key: g[0].index, text: say(textOf(g)), outBase: bases.get(g[0].index)! })), FFMPEG, project.ownerId,
      { provider: chosenProvider, voice: chosenVoice, speed: tone?.speed })
    for (const [k, v] of got) made.set(k, v)
  }
  for (const [idx, file] of directed) made.set(idx, { path: file, provider: quoteOf(scenes.find((s) => s.index === idx)!) ? 'fala' : 'studio' })

  // Fala clara: o Whisper ouve cada frase e compara com o texto. Pouco clara, gera de novo com a MESMA voz (até 2 vezes)
  // e fica com a melhor. Kokoro e Piper sempre geram igual, então nelas só confere e avisa.
  const spoken = groups.filter((g) => made.has(g[0].index))
  const others = (await activeProviders('voz', project.ownerId)).map((a) => a.provider)
  for (const [n, g] of spoken.entries()) {
    const text = textOf(g), base0 = bases.get(g[0].index)!
    let best = made.get(g[0].index)!
    let score = await clarity(best.path, text)
    if (score === null) break // Whisper não instalado: segue sem conferir
    await checkCancel(job.id)
    await prisma.job.update({ where: { id: job.id }, data: { stage: `Conferindo se a fala ficou clara · frase ${n + 1} de ${spoken.length}` } })
    const random = ['studio', 'elevenlabs', 'openai_tts'].includes(best.provider)
    for (let attempt = 1; random && score < 0.7 && attempt <= 2; attempt++) {
      const base = `${base0}-clareza${attempt}`
      let file: string | null = null
      if (best.provider === 'studio' && own?.profileId) {
        await writeFile(base + '.studio.wav', await studioGenerate({ text: say(text), profileId: own.profileId, speed: own.speed, seed: 42 + attempt }))
        await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', base + '.studio.wav', '-ar', '48000', '-ac', '2', base + '.wav'])
        file = base + '.wav'
      } else if (best.provider !== 'studio') {
        file = (await synthesize(say(text), base, FFMPEG, project.ownerId, others.filter((o) => o !== best.provider), { provider: chosenProvider, voice: chosenVoice, speed: tone?.speed }))?.path ?? null
      }
      const again = file ? await clarity(file, text) : null
      if (file && again !== null && again > score) { best = { path: file, provider: best.provider }; score = again }
    }
    made.set(g[0].index, best)
    if (score < 0.7) logEvent({ level: 'warn', source: 'worker', kind: 'job', message: `cena ${g[0].index + 1}: fala pode estar pouco clara (${Math.round(score * 100)}% das palavras reconhecidas)`, details: { jobId: job.id, projectId: project.id } })
  }

  // Pausas estratégicas: respiro curto depois de cada frase e uma pausa maior quando começa um novo contexto
  // (quadro de título/capítulo ou cena com texto de tela), para o espectador sentir a virada.
  const isNewContext = (s: S) => !!s.onScreenText || (s.searchQuery ? JSON.parse(s.searchQuery).type === 'text_card' : false)
  const groupOf = new Map(groups.flatMap((g) => g.map((s) => [s.index, g] as [number, S[]])))
  const onFrame = (x: number) => Math.round(x * 30) / 30
  let t = 0
  const cardRow = await prisma.setting.findUnique({ where: { key: `card_duration:${project.ownerId}` } })
  const cardDefault = cardRow ? Number(cardRow.value) : null
  for (const [i, s] of scenes.entries()) {
    await step('Narração com a voz escolhida', 60 + Math.round((i / scenes.length) * 35))
    const g = groupOf.get(s.index) ?? [s]
    if (g[0] !== s) continue // já tratada junto com o começo da frase
    const lastI = i + g.length - 1, next = scenes[lastI + 1]
    // Ritmo de YouTube: respiro curto entre frases e um pouco mais só na virada de capítulo.
    const lead = i === 0 ? INTRO_S : isNewContext(s) ? 0.25 : 0.05
    // Antes do corte de uma fala: o locutor pausa 2 s (depois as cenas esmaecem 3 s para o corte entrar).
    const tail = next && quoteOf(next) ? 2 : next && isNewContext(next) ? 0.4 : 0.18
    const v = made.get(s.index)
    if (!v) {
      // Cena sem fala (cartela): a duração padrão da pessoa, se ela definiu uma; senão 3 s (+ a abertura, se for a primeira).
      const dur = s.narration?.trim() ? s.endS - s.startS : (cardDefault ?? 3) + (i === 0 ? INTRO_S : 0)
      await prisma.scene.update({ where: { id: s.id }, data: { startS: t, endS: t + dur } })
      t += dur
      continue
    }
    // A fala vira um WAV com o silêncio de entrada e de saída já embutidos.
    const out = bases.get(s.index)! + '.final.wav'
    const clip = quoteOf(s)
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', v.path, '-af',
      // Narrador: corta só o silêncio do FIM (cortar o do começo comia a 1ª sílaba). Corte de fala enviado: nada é cortado.
      `${clip ? '' : 'areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse,'}adelay=${Math.round(lead * 1000)}:all=1,apad=pad_dur=${tail}`, '-ar', '48000', '-ac', '2', out])
    let dur = await durationOf(out)
    // A cena do corte dura o vídeo inteiro dele (mesmo que passe do tempo pedido).
    if (clip) dur = Math.max(dur, lead + (await durationOf(clip.filePath)) + tail)
    // Frase em várias cenas: divide o áudio pelo tamanho do texto de cada uma, no quadro exato, sem buraco entre elas.
    const cuts = splitPoints(g.map((x) => x.narration!.trim().length), lead, dur - tail).map((b) => onFrame(t + b) - t)
    for (const [j, x] of g.entries()) {
      const a = j === 0 ? 0 : cuts[j - 1], b = j === g.length - 1 ? dur : cuts[j]
      const file = g.length === 1 ? out : `${bases.get(x.index)!}.parte.wav`
      if (g.length > 1) await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', out, '-af', `atrim=${a.toFixed(4)}:${b.toFixed(4)},asetpts=PTS-STARTPTS`, '-ar', '48000', '-ac', '2', file])
      await prisma.asset.create({ data: { projectId: project.id, kind: 'voice', filePath: file, mime: 'audio/wav', durationS: b - a, sourceProvider: v.provider, sortOrder: x.index } })
      await prisma.scene.update({ where: { id: x.id }, data: { startS: t + a, endS: t + b } })
    }
    t += dur
  }
  if (t > MAX_DURATION_S) throw new Error(`Com a locução o vídeo ficou com ${Math.round(t)}s, acima de 60 minutos. Encurte o roteiro.`)

  // A trilha não entra na criação: é escolhida no editor e buscada no render.

  // Guarda com qual voz/ritmo a narração foi feita: o render compara com a escolha atual e narra de novo se mudou.
  const fresh = JSON.parse((await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { options: true } })).options)
  await prisma.project.update({ where: { id: project.id }, data: { status: 'rendering', options: JSON.stringify({ ...fresh, voicedWith: voiceKey(opts) }) } })
  await prisma.job.create({ data: { projectId: project.id, type: 'render', stage: 'Na fila' } })
}

// Frase terminada: ponto final, exclamação, interrogação ou reticências (aspas e parênteses depois contam junto).
export const endsSentence = (t: string) => /[.!?…]["”'»)\]]*$/.test(t.trim())

// Onde dividir o áudio de uma frase entre as cenas: proporcional ao texto de cada uma, dentro do trecho falado [from, to].
export function splitPoints(chars: number[], from: number, to: number) {
  const total = chars.reduce((n, c) => n + c, 0) || 1
  let acc = 0
  return chars.slice(0, -1).map((c) => from + ((acc += c) / total) * (to - from))
}
