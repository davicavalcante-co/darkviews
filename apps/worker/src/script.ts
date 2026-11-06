import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma, type Job } from '@corte/db'
import { researchKit } from '@corte/providers'
import { checkPlan, MAX_DURATION_S, ScriptOutput } from '@corte/shared'
import { askClaude } from './claude.js'
import { imageSheet } from './media.js'

// Estilo de edição escolhido em Novo vídeo: puxa o roteiro para um tipo de movimento.
const EDIT_STYLE: Record<string, string> = {
  auto: '',
  documentario: 'Estilo pedido: documentário. Prefira ken_burns com ease_in_out e transições cut/fade.',
  dinamico: 'Estilo pedido: dinâmico. Use muito snap_zoom, punch_in, whip e slide_*, cenas curtas.',
  revista: 'Estilo pedido: recorte de revista. Use cutout na maioria das fotos, com cut e slide_*.',
  profundidade: 'Estilo pedido: profundidade 2.5D. Use parallax sempre que a foto tiver um objeto em destaque.',
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

export async function script(job: Job) {
  const { hint } = JSON.parse(job.payload ?? '{}') as { hint?: string }
  const project = await prisma.project.update({
    where: { id: job.projectId }, data: { status: 'scripting' },
    include: { reference: true, assets: { where: { kind: { in: ['user_image', 'user_video'] } }, orderBy: { sortOrder: 'asc' } } },
  })
  const images = project.assets.filter((a) => a.kind === 'user_image')
  const talkingVideo = project.assets.find((a) => a.kind === 'user_video')
  const options = JSON.parse(project.options) as { mediaMode?: string; method?: string; analysisId?: string; fontFamily?: string; highlightMode?: string; talkingHead?: 'stock' | 'upload'; useStock?: boolean; editStyle?: string }
  // Vídeo da aba Análise escolhido como referência: a análise completa (roteiro, gancho, técnicas, ritmo...) guia o roteiro.
  const analysis = options.analysisId ? await prisma.videoAnalysis.findFirst({ where: { id: options.analysisId, ownerId: project.ownerId, status: 'done' }, select: { title: true, channel: true, details: true } }) : null
  // Pasta temporária só com as imagens do usuário, para o Claude abrir (Read) sem ver o resto do disco.
  const dir = await mkdtemp(join(tmpdir(), 'corte-roteiro-'))
  try {
    const names = await Promise.all(images.map(async (a, i) => {
      const name = `imagem-${i}.${EXT[a.mime] ?? 'jpg'}`
      await symlink(a.filePath, join(dir, name))
      return name
    }))
    // Folhas de até 24 imagens: o Claude vê todas em poucas leituras (cada leitura extra reenvia o contexto inteiro).
    const sheets: string[] = []
    for (let i = 0; i < images.length; i += 24) sheets.push(await imageSheet(images.slice(i, i + 24).map((a) => a.filePath), join(dir, `folha-${sheets.length + 1}.jpg`)).then((f) => f.split('/').pop()!))
    await prisma.job.update({ where: { id: job.id }, data: { stage: 'Claude escrevendo o roteiro', progress: 20 } })

    const base = [
      'Você é roteirista de YouTube e editor de vídeos. Escreva o roteiro e o plano de cenas de um vídeo horizontal 16:9.',
      [
        'Antes de escrever:',
        '1) Pesquise na web (WebSearch/WebFetch) o assunto: fatos confirmados, datas, números, curiosidades pouco conhecidas e detalhes humanos. Não invente nada; prefira o que aparece em mais de uma fonte.',
        '2) Analise o público desse assunto: quem assiste, o que já sabe, o que mais desperta curiosidade e emoção nesse nicho, quais perguntas ele faz e o que faria ele parar de rolar o feed.',
        '3) Analise o estilo de vídeo pedido (pelo prompt e pela referência, se houver) e escreva nesse estilo.',
      ].join(' '),
      [
        'Escreva no estilo dos melhores canais de YouTube:',
        'gancho nos primeiros 5 segundos (uma pergunta, um fato surpreendente ou uma cena forte, nunca "olá, neste vídeo");',
        'conte como uma história, com começo, tensão e virada, em ordem que prenda (pode abrir pelo momento mais marcante e voltar);',
        'abra perguntas e só responda mais à frente ("e o que ele fez depois mudou tudo...");',
        'espalhe curiosidades ao longo do vídeo, uma a cada 20 a 40 segundos, para renovar a atenção;',
        'convide quem assiste a imaginar, sentir e refletir ("imagine você...", "pense nisso por um segundo...");',
        'ênfase: frases curtas nos momentos fortes, ritmo variado, palavras concretas e visuais, fala de conversa (você, a gente), sem jargão;',
        'feche com um final que emocione ou surpreenda e um convite natural para comentar ou se inscrever.',
      ].join(' '),
      `Pedido do cliente (siga fielmente: se trouxer título, gancho, ângulo e tópicos, use esse título e esse gancho e cubra todos os tópicos, na ordem):\n"""\n${project.prompt}\n"""`,
      analysis?.details ? `Análise completa do vídeo de referência escolhido ("${analysis.title ?? 'sem título'}"${analysis.channel ? `, canal ${analysis.channel}` : ''}). Reproduza no roteiro novo a mesma estrutura, o tipo de gancho, as técnicas de roteiro, o tom, o ritmo e as pausas, as ênfases, a dinâmica para prender a atenção e a chamada para ação descritos aqui, com o conteúdo do pedido (não copie as falas):\n${analysis.details}` : '',
      // Refazer o roteiro pela tela de aprovação: a orientação do cliente manda.
      hint ? `O cliente leu o roteiro anterior e pediu para refazer assim:\n"""\n${hint}\n"""` : '',
      `Duração aproximada: ${project.targetDurationS} s. Pode passar alguns segundos ou minutos se isso deixar o vídeo melhor; qualidade vem antes do tempo exato (nunca acima de ${MAX_DURATION_S} s). As cenas devem ser contínuas: cada uma começa onde a anterior termina, a primeira em 0.`,
      `Troque de imagem a cada 3 a 6 segundos, ou no ritmo do perfil de estilo abaixo.`,
      'Toda cena tem narração, sem silêncio. A única exceção são as cartelas de capítulo: media.type "text_card" com o título curto (2 a 5 palavras, caixa alta), narração vazia e 3 s. Use 2 ou 3 cartelas por vídeo, nas viradas de assunto.',
      'onScreenText (faixa de destaque sobre a imagem) só em 1 a cada 4 cenas, com 2 a 4 palavras de impacto. Nas outras, deixe vazio.',
      'Siga o visual do perfil de estilo (cores, tipo de cartela, citações, ritmo dos cortes) quando houver referência.',
      'Edição dinâmica, como um editor profissional: varie transição e movimento a cada cena, sem repetir o mesmo par duas vezes seguidas.',
      'Transições: cortes secos (cut) na maior parte; punch_in/punch_out para ênfase; whip e slide_* para ritmo; zoom_through e fade só em viradas de assunto.',
      'Movimento das fotos: ken_burns como base, com easing variado; parallax quando a foto tem um objeto ou pessoa em destaque; snap_zoom em frases de impacto; cutout em trechos explicativos ou listas.',
      options.method === 'cortes'
        ? 'MÉTODO VÍDEO POR CORTES: a imagem será uma montagem de cortes aleatórios dos vídeos do cliente, sem relação cena a cena com a fala. Use media.type "user_video" em TODAS as cenas, sem cartelas (text_card) e com onScreenText vazio. Capriche só na narração; transição "cut" e sem movimento.'
        : EDIT_STYLE[options.editStyle ?? 'auto'],
      options.mediaMode === 'images' ? 'Use só fotos (kind "image"), nunca vídeo de banco.' : options.mediaMode === 'videos' ? 'Use só vídeos de banco (kind "video"), nunca foto parada.' : '',
      project.reference?.styleProfile ? `Perfil de estilo da referência (imite o estilo, não copie o conteúdo):\n${project.reference.styleProfile}` : 'Sem vídeo de referência: escolha um estilo adequado ao pedido.',
      images.length
        ? `Imagens do cliente (prefira usá-las). Para ver o que mostram, abra com Read só estas folhas, que juntam as imagens em grade de 6 colunas, da esquerda para a direita e de cima para baixo, 24 por folha: ${sheets.join(', ')}. A posição na grade é o índice (a 1ª imagem da folha-2 é o índice 24).\n${names.map((n, i) => `- índice ${i}: legenda: ${images[i].userCaption || 'sem legenda'}`).join('\n')}`
        : 'O cliente não enviou imagens.',
      options.useStock === false && images.length
        ? 'O cliente pediu para usar SÓ as imagens dele: não use banco de imagens. Repita as imagens dele quando faltar, variando a ordem e a transição.'
        : '',
      [
        'Para cenas sem imagem do cliente, busque a imagem mais fiel possível ao que está sendo dito, em níveis (do mais específico ao mais genérico), 1 ou 2 termos por nível, e preencha "levels" com o nível de cada termo:',
        'nível 1: exatamente o que é dito, com o nome real (ex.: fala sobre Vini Jr chorando → "Vinicius Junior chorando", "Vinicius Junior crying");',
        'nível 2: relação direta que explica bem o que é dito (ex.: "Vinicius Junior cabeça baixa", "Vinicius Junior triste sério");',
        'nível 3: relação indireta, mas dentro do assunto (ex.: "Vinicius Junior Real Madrid");',
        'nível 4: pouca relação direta (ex.: "jogador de futebol triste").',
        'Pessoa famosa citada (de qualquer área): sempre o nome real dela nos níveis 1 a 3, em português e em inglês. Fatos, jogos, lugares e marcas: o nome real também. Seja específico e realista.',
        'Produto citado: a foto do próprio produto, nunca uma imagem que só lembre ele. Use marca + nome + modelo/versão exatos nos níveis 1 a 3 (ex.: "iPhone 15 Pro Max titânio natural", "Nike Air Jordan 1 Chicago", "Açaí Só a Papa Sabor do Norte embalagem"); nível 4 só a categoria do produto.',
        'Use quadro de texto só quando nada servir. Não use pessoas de banco para representar clientes reais.',
      ].join(' '),
      options.talkingHead === 'upload' && talkingVideo
        ? 'Nos trechos em que a referência mostra uma pessoa falando para a câmera, use media.type "user_video" (o vídeo do cliente, sem som, com a legenda passando).'
        : options.talkingHead === 'stock'
          ? 'Nos trechos em que a referência mostra uma pessoa falando para a câmera, use vídeo de banco (kind "video") de uma pessoa falando, com termos como "person talking to camera", "woman speaking to camera", "man presenter talking".'
          : 'Não use media.type "user_video" (o cliente não enviou vídeo).',
      `Legendas: fonte ${options.fontFamily ?? 'padrão'}, destaque ${options.highlightMode ?? 'palavra-chave'}.`,
      'Escreva título, descrição (para YouTube) e palavras-chave em português do Brasil.',
    ].join('\n\n')

    const web = (await researchKit(project.ownerId)).web
    let plan: ScriptOutput | null = null
    let feedback = ''
    for (let attempt = 1; attempt <= 2 && !plan; attempt++) {
      const out = await askClaude({ jobId: job.id, cwd: dir, canReadFiles: images.length > 0, research: web, maxTurns: 40, schema: ScriptOutput, prompt: base + feedback })
      const problems = checkPlan(out, project.targetDurationS, images.length)
      if (!problems.length) plan = out
      else feedback = `\n\nSua resposta anterior tinha estes problemas; corrija todos:\n- ${problems.join('\n- ')}`
      await prisma.job.update({ where: { id: job.id }, data: { progress: 60 } })
    }
    if (!plan) throw new Error('O plano de cenas veio inválido duas vezes: ' + feedback.split('\n- ').slice(1).join('; '))
    await save(project.id, plan, images.map((a) => a.id), talkingVideo?.id)
  } finally { await rm(dir, { recursive: true, force: true }) }

  // Para aqui: a pessoa lê o roteiro e aprova, edita ou pede para refazer (tela de Andamento).
  await prisma.project.update({ where: { id: project.id }, data: { status: 'script_review', reviewUntil: new Date(Date.now() + 10 * 60_000) } }) // 10 min para aprovar; passou, aprova sozinho
}

async function save(projectId: string, plan: ScriptOutput, imageIds: string[], talkingVideoId?: string) {
  await prisma.$transaction(async (tx) => {
    const version = ((await tx.script.aggregate({ where: { projectId }, _max: { version: true } }))._max.version ?? 0) + 1
    await tx.script.create({
      data: {
        projectId, version, body: plan.body, scenePlan: JSON.stringify(plan.scenes), createdBy: 'claude',
        scenes: {
          create: plan.scenes.map((s, index) => ({
            index, startS: s.startS, endS: s.endS, narration: s.narration, onScreenText: s.onScreenText || null, transition: s.transition, motion: s.motion, easing: s.easing,
            assetId: s.media.type === 'user_image' ? imageIds[s.media.imageIndex] : s.media.type === 'user_video' ? talkingVideoId ?? null : null,
            searchQuery: s.media.type === 'stock' ? JSON.stringify(s.media) : s.media.type === 'text_card' ? JSON.stringify(s.media) : null,
          })),
        },
      },
    })
    for (const [field, value] of [['title', plan.title], ['description', plan.description], ['keywords', plan.keywords.join(', ')]] as const) {
      await tx.metadataField.updateMany({ where: { projectId, field }, data: { isCurrent: false } })
      const v = ((await tx.metadataField.aggregate({ where: { projectId, field }, _max: { version: true } }))._max.version ?? 0) + 1
      await tx.metadataField.create({ data: { projectId, field, version: v, value, createdBy: 'claude' } })
    }
  })
}
