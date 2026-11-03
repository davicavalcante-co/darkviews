import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma, type Job } from '@corte/db'
import { StyleProfile } from '@corte/shared'
import { askClaude } from './claude.js'
import { detectScenes, extractFrames, transcribe } from './media.js'

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
      const frames = await extractFrames(ref.filePath, ref.durationS, dir)
      await stage(job, 'Transcrevendo o áudio', 40)
      const transcript = await transcribe(ref.filePath, dir)
      await stage(job, 'Claude analisando o estilo', 60)

      const profile = await askClaude({
        jobId: job.id, cwd: dir, canReadFiles: true, effort: 'medium', schema: StyleProfile,
        prompt: [
          'Você analisa um vídeo de referência para recriar o ESTILO dele (não o conteúdo) num vídeo novo.',
          `Duração: ${ref.durationS.toFixed(1)} s. Plataforma: ${ref.platform ?? 'upload'}.`,
          `Trocas de cena detectadas pelo FFmpeg (${cuts.length}, em segundos): ${cuts.map((c) => c.toFixed(1)).join(', ') || 'nenhuma'}.`,
          `Cortes por minuto medidos: ${((cuts.length / ref.durationS) * 60).toFixed(1)}.`,
          `Quadros-chave nesta pasta, em ordem: ${frames.join(', ')}. Abra todos com a ferramenta Read antes de responder.`,
          transcript ? `Transcrição da fala:\n"""\n${transcript.slice(0, 20_000)}\n"""` : 'Sem transcrição disponível.',
          'Responda em português, com o perfil de estilo no formato pedido.',
        ].join('\n\n'),
      })
      await prisma.reference.update({ where: { id: ref.id }, data: { styleProfile: JSON.stringify({ ...profile, transcriptAvailable: !!transcript }) } })
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
  await prisma.project.update({ where: { id: project.id }, data: { status: 'scripting' } })
  await prisma.job.create({ data: { projectId: project.id, type: 'script', stage: 'Na fila' } })
}
