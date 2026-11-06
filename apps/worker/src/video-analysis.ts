import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { logEvent, prisma, STORAGE_DIR } from '@corte/db'
import { AnalysisDetails, StyleProfile } from '@corte/shared'
import { researchKit, youtubeStats } from '@corte/providers'
import { askClaude } from './claude.js'
import { FFMPEG, run } from './ffmpeg.js'
import { download, probeDuration } from './ingest.js'
import { contactSheet, detectScenes, transcribe } from './media.js'

const Result = z.object({ profile: StyleProfile, details: AnalysisDetails })

// Aba Análise: pega a próxima análise na fila (uma por vez) e analisa o vídeo do link em detalhe.
export async function runNextAnalysis(workerJobId: string | null) {
  const next = await prisma.videoAnalysis.findFirst({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' } })
  if (!next) return false
  const { count } = await prisma.videoAnalysis.updateMany({ where: { id: next.id, status: 'queued' }, data: { status: 'running', stage: 'Baixando o vídeo', error: null } })
  if (!count) return true
  const stage = (s: string) => prisma.videoAnalysis.update({ where: { id: next.id }, data: { stage: s } })
  const dir = await mkdtemp(join(tmpdir(), 'darkviews-analise-'))
  let video: string | null = null
  try {
    const got = await download(next.url)
    video = got.path
    const durationS = (await probeDuration(video)) ?? 0
    // Miniatura: um quadro do começo do vídeo (fica guardada; o vídeo baixado é apagado no fim).
    const thumbs = join(STORAGE_DIR, 'analyses')
    await mkdir(thumbs, { recursive: true })
    const thumbPath = join(thumbs, `${next.id}.jpg`)
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.min(3, durationS * 0.1)), '-i', video, '-frames:v', '1', '-vf', 'scale=960:-2', thumbPath])
    await prisma.videoAnalysis.update({ where: { id: next.id }, data: { title: got.title, channel: got.channel, durationS, thumbPath } })

    await stage('Detectando cortes e transições')
    const cuts = await detectScenes(video)
    await stage('Extraindo quadros')
    const count = Math.min(48, Math.max(12, Math.round(durationS / 4 / 6) * 6))
    const sheet = await contactSheet(video, durationS, dir, count)
    await stage('Transcrevendo as falas')
    const transcript = await transcribe(video, dir)
    const yt = await researchKit(next.ownerId).then((k) => (k.youtube ? youtubeStats(k.youtube, next.url) : null)).catch(() => null)
    await stage('Claude analisando tudo')
    const out = await askClaude({
      jobId: workerJobId ?? '', cwd: dir, canReadFiles: true, effort: 'high', schema: Result, maxTurns: 6, // sem tarefa de vídeo: o uso do Claude fica sem vínculo
      prompt: [
        'Analise este vídeo em detalhe para alguém que quer aprender e copiar o ESTILO dele (não o conteúdo) num vídeo novo.',
        'Cubra tudo, com exemplos concretos e o segundo em que acontecem: roteiro e estrutura, gancho, técnicas de roteiro, falas marcantes, tom, ritmo e pausas da fala, destaques e ênfases, edição (ritmo de cortes), motion (zoom, pan, parallax...), transições, design (cores em hex, tipografia, elementos gráficos), dinâmica para prender a atenção, música e efeitos, chamada para ação, linha do tempo e um passo a passo para recriar.',
        'Preencha também "profile" (o perfil de estilo usado na criação de vídeos). Marque talkingHead quando houver uma pessoa falando para a câmera.',
        `Título: ${got.title ?? 'desconhecido'}. Duração: ${durationS.toFixed(1)} s. Plataforma: ${next.platform ?? 'link'}.`,
        `Trocas de cena detectadas (${cuts.length}, em segundos): ${cuts.map((c) => c.toFixed(1)).join(', ') || 'nenhuma'}. Cortes por minuto: ${((cuts.length / Math.max(durationS, 1)) * 60).toFixed(1)}.`,
        `Abra com Read o arquivo ${sheet.file.split('/').pop()}: ${sheet.times.length} quadros em grade de ${sheet.cols} colunas, da esquerda para a direita e de cima para baixo. Tempo de cada quadro, em segundos: ${sheet.times.join(', ')}.`,
        yt ? `Números no YouTube: canal ${yt.channel}, publicado em ${yt.published}, ${yt.views} visualizações, ${yt.likes} curtidas, ${yt.comments} comentários. Comente o desempenho no resumo.` : '',
        transcript ? `Transcrição da fala:\n"""\n${transcript.slice(0, 20_000)}\n"""` : 'Sem transcrição: deduza o que puder pelos quadros.',
        'Responda em português do Brasil.',
      ].filter(Boolean).join('\n\n'),
    })
    await prisma.videoAnalysis.update({ where: { id: next.id }, data: { status: 'done', stage: null, profile: JSON.stringify({ ...out.profile, transcriptAvailable: !!transcript }), details: JSON.stringify(out.details) } })
  } catch (e) {
    const message = (e as Error).message
    logEvent({ level: 'error', source: 'worker', kind: 'job', message: `análise de vídeo falhou: ${message}`, details: { analysisId: next.id } })
    await prisma.videoAnalysis.update({ where: { id: next.id }, data: { status: 'failed', stage: null, error: message.slice(0, 500) } })
  } finally {
    await rm(dir, { recursive: true, force: true })
    if (video) await rm(video, { force: true })
  }
  return true
}
