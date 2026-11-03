import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma, type Job } from '@corte/db'
import { checkPlan, ScriptOutput } from '@corte/shared'
import { askClaude } from './claude.js'

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

export async function script(job: Job) {
  const project = await prisma.project.update({
    where: { id: job.projectId }, data: { status: 'scripting' },
    include: { reference: true, assets: { where: { kind: 'user_image' }, orderBy: { sortOrder: 'asc' } } },
  })
  const images = project.assets
  const options = JSON.parse(project.options) as { fontFamily?: string; highlightMode?: string }
  // Pasta temporária só com as imagens do usuário, para o Claude abrir (Read) sem ver o resto do disco.
  const dir = await mkdtemp(join(tmpdir(), 'corte-roteiro-'))
  try {
    const names = await Promise.all(images.map(async (a, i) => {
      const name = `imagem-${i}.${EXT[a.mime] ?? 'jpg'}`
      await symlink(a.filePath, join(dir, name))
      return name
    }))
    await prisma.job.update({ where: { id: job.id }, data: { stage: 'Claude escrevendo o roteiro', progress: 20 } })

    const base = [
      'Você é roteirista e editor de vídeos. Escreva o roteiro e o plano de cenas de um vídeo horizontal 16:9.',
      `Pedido do cliente:\n"""\n${project.prompt}\n"""`,
      `Duração alvo: ${project.targetDurationS} s (nunca acima de 1080 s). As cenas devem ser contínuas: cada uma começa onde a anterior termina, a primeira em 0 e a última termina na duração alvo.`,
      `Troque de imagem a cada 3 a 6 segundos, ou no ritmo do perfil de estilo abaixo.`,
      project.reference?.styleProfile ? `Perfil de estilo da referência (imite o estilo, não copie o conteúdo):\n${project.reference.styleProfile}` : 'Sem vídeo de referência: escolha um estilo adequado ao pedido.',
      images.length
        ? `Imagens do cliente (prefira usá-las; abra cada uma com Read para ver o que mostram):\n${names.map((n, i) => `- índice ${i}: ${n} — legenda: ${images[i].userCaption || 'sem legenda'}`).join('\n')}`
        : 'O cliente não enviou imagens.',
      'Para cenas sem imagem do cliente, use banco de imagens/vídeos com 2 a 3 termos de busca em inglês. Use quadro de texto só quando nada servir. Não use pessoas de banco para representar clientes reais.',
      `Legendas: fonte ${options.fontFamily ?? 'padrão'}, destaque ${options.highlightMode ?? 'palavra-chave'}.`,
      'Escreva título, descrição (para YouTube) e palavras-chave em português do Brasil.',
    ].join('\n\n')

    let plan: ScriptOutput | null = null
    let feedback = ''
    for (let attempt = 1; attempt <= 2 && !plan; attempt++) {
      const out = await askClaude({ jobId: job.id, cwd: dir, canReadFiles: images.length > 0, schema: ScriptOutput, prompt: base + feedback })
      const problems = checkPlan(out, project.targetDurationS, images.length)
      if (!problems.length) plan = out
      else feedback = `\n\nSua resposta anterior tinha estes problemas; corrija todos:\n- ${problems.join('\n- ')}`
      await prisma.job.update({ where: { id: job.id }, data: { progress: 60 } })
    }
    if (!plan) throw new Error('O plano de cenas veio inválido duas vezes: ' + feedback.split('\n- ').slice(1).join('; '))
    await save(project.id, plan, images.map((a) => a.id))
  } finally { await rm(dir, { recursive: true, force: true }) }

  await prisma.project.update({ where: { id: project.id }, data: { status: 'media' } })
  // Próxima etapa: mídia e render (Fase 4). Fica na fila até lá.
  await prisma.job.create({ data: { projectId: project.id, type: 'media', stage: 'Aguardando busca de imagens' } })
}

async function save(projectId: string, plan: ScriptOutput, imageIds: string[]) {
  await prisma.$transaction(async (tx) => {
    const version = ((await tx.script.aggregate({ where: { projectId }, _max: { version: true } }))._max.version ?? 0) + 1
    await tx.script.create({
      data: {
        projectId, version, body: plan.body, scenePlan: JSON.stringify(plan.scenes), createdBy: 'claude',
        scenes: {
          create: plan.scenes.map((s, index) => ({
            index, startS: s.startS, endS: s.endS, narration: s.narration, onScreenText: s.onScreenText || null, transition: s.transition,
            assetId: s.media.type === 'user_image' ? imageIds[s.media.imageIndex] : null,
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
