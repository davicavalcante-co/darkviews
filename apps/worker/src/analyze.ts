import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma, type Job } from '@corte/db'
import { StyleProfile } from '@corte/shared'
import { askClaude } from './claude.js'
import { contactSheet, detectScenes, transcribe } from './media.js'

const stage = (job: Job, stage: string, progress: number) => prisma.job.update({ where: { id: job.id }, data: { stage, progress } })

export async function analyze(job: Job) {
  const project = await prisma.project.update({ where: { id: job.projectId }, data: { status: 'analyzing' }, include: { reference: true } })
  const ref = project.reference
  if (ref?.filePath && ref.durationS) {
    const dir = await mkdtemp(join(tmpdir(), 'corte-analise-'))
    try {
      await stage(job, 'Detectando cortes de cena', 10)
      const cuts = await detectScenes(ref.filePath)
      await stage(job, 'Extraindo quadros-chave', 25)
      // ~1 quadro a cada 5 s (entre 12 e 48), numa folha só.
      const count = Math.min(48, Math.max(12, Math.round(ref.durationS / 5 / 6) * 6))
      const sheet = await contactSheet(ref.filePath, ref.durationS, dir, count)
      await stage(job, 'Transcrevendo o áudio', 40)
      const transcript = await transcribe(ref.filePath, dir)
      await stage(job, 'Claude analisando o estilo', 60)

      const profile = await askClaude({
        jobId: job.id, cwd: dir, canReadFiles: true, effort: 'medium', schema: StyleProfile, maxTurns: 4,
        prompt: [
          'Você analisa um vídeo de referência para recriar o ESTILO dele (não o conteúdo) num vídeo novo. Seja específico e concreto em cada campo: transições, composição, cenários, tipo de imagem (foto, vídeo, ilustração), textos na tela, áudio e recomendações práticas. Nada genérico.',
          'Marque talkingHead quando houver uma pessoa falando para a câmera (o mesmo enquadramento de rosto repetido em vários quadros).',
          `Duração: ${ref.durationS.toFixed(1)} s. Plataforma: ${ref.platform ?? 'upload'}.`,
          `Trocas de cena detectadas pelo FFmpeg (${cuts.length}, em segundos): ${cuts.map((c) => c.toFixed(1)).join(', ') || 'nenhuma'}.`,
          `Cortes por minuto medidos: ${((cuts.length / ref.durationS) * 60).toFixed(1)}.`,
          `Abra com Read o arquivo ${sheet.file.split('/').pop()}: uma folha com ${sheet.times.length} quadros em grade de ${sheet.cols} colunas, da esquerda para a direita e de cima para baixo. Tempos de cada quadro, em segundos: ${sheet.times.join(', ')}.`,
          transcript ? `Transcrição da fala:\n"""\n${transcript.slice(0, 20_000)}\n"""` : 'Sem transcrição disponível.',
          'Responda em português, com o perfil de estilo no formato pedido.',
        ].join('\n\n'),
      })
      await prisma.reference.update({ where: { id: ref.id }, data: { styleProfile: JSON.stringify({ ...profile, transcriptAvailable: !!transcript }) } })
      // Pessoa falando na referência: para e pergunta ao cliente (vídeo de banco ou o vídeo dele) antes do roteiro.
      if (profile.talkingHead.present && !(JSON.parse(project.options) as { talkingHead?: string }).talkingHead) {
        await prisma.project.update({ where: { id: project.id }, data: { status: 'talking_head' } })
        return
      }
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
  await prisma.project.update({ where: { id: project.id }, data: { status: 'scripting' } })
  await prisma.job.create({ data: { projectId: project.id, type: 'script', stage: 'Na fila' } })
}
