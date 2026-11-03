import { hostname } from 'node:os'
import { prisma, claimNextJob, estimateSeconds, logEvent, type Job } from '@corte/db'
import { ingest } from './ingest.js'
import { analyze } from './analyze.js'
import { script } from './script.js'
import { media } from './media-job.js'
import { render } from './render.js'
import { regenPart } from './regen-part.js'
import { cuts } from './cuts.js'
import { ClaudeUnavailable, recordStatus } from './claude.js'
import { checkClaude, holdLongVideo } from './claude-check.js'

const WORKER_ID = `${hostname()}:${process.pid}`
const HANDLERS: Record<string, (job: Job) => Promise<void>> = { ingest, analyze, script, media, render, regen_part: regenPart, cuts }

// shortcut: jobs "running" de um worker que caiu ficam presos; ao iniciar, devolvemos os nossos para a fila.
await prisma.job.updateMany({ where: { status: 'running', lockedBy: { startsWith: hostname() + ':' } }, data: { status: 'queued', lockedBy: null } })

async function runOne() {
  // Jobs pausados pelo limite do Claude voltam sozinhos para a fila no horário de reinício.
  await prisma.job.updateMany({ where: { status: 'paused', resumeAt: { lte: new Date() } }, data: { status: 'queued', resumeAt: null } })
  const job = await claimNextJob(WORKER_ID, Object.keys(HANDLERS))
  if (!job) return false
  // Jobs que usam o Claude: vídeo longo espera se a sessão estiver perto do limite.
  if (['analyze', 'script', 'regen_part'].includes(job.type)) {
    const until = await holdLongVideo(job.projectId)
    if (until) {
      await prisma.job.update({ where: { id: job.id }, data: { status: 'paused', stage: 'Aguardando a sessão do Claude reiniciar (vídeo longo)', resumeAt: until, lockedBy: null } })
      return true
    }
  }
  const started = Date.now()
  console.log(`[worker] ${job.type} ${job.id}`)
  logEvent({ source: 'worker', kind: 'job', message: `${job.type} iniciado`, details: { jobId: job.id, projectId: job.projectId } })
  try {
    const target = await inputDuration(job.projectId)
    await prisma.job.update({ where: { id: job.id }, data: { etaS: await estimateSeconds(job.type, target) } })
    await HANDLERS[job.type](job)
    await prisma.job.update({ where: { id: job.id }, data: { status: 'done', progress: 100, etaS: 0, finishedAt: new Date() } })
    logEvent({ source: 'worker', kind: 'job', message: `${job.type} concluído em ${((Date.now() - started) / 1000).toFixed(1)} s`, details: { jobId: job.id, projectId: job.projectId } })
    await prisma.jobMetric.create({
      data: { jobType: job.type, inputDurationS: await inputDuration(job.projectId), elapsedS: (Date.now() - started) / 1000 },
    })
  } catch (e) {
    if (e instanceof ClaudeUnavailable) {
      console.warn(`[worker] pausado ${job.id}: ${e.message}`)
      logEvent({ level: 'warn', source: 'worker', kind: 'claude', message: `${job.type} pausado: ${e.message}`, details: { jobId: job.id, reason: e.reason, resumeAt: e.resumeAt } })
      await recordStatus({ available: false, reason: e.reason, ...(e.reason === 'rate_limit' && { sessionResetsAt: e.resumeAt }) })
      await prisma.job.update({ where: { id: job.id }, data: { status: 'paused', stage: e.message, resumeAt: e.resumeAt, lockedBy: null } })
      return true
    }
    const message = e instanceof Error ? e.message : String(e)
    console.error(`[worker] falhou ${job.id}: ${message}`)
    logEvent({ level: 'error', source: 'worker', kind: 'job', message: `${job.type} falhou: ${message}`, details: { jobId: job.id, projectId: job.projectId, stack: (e as Error).stack?.split('\n').slice(0, 8).join('\n'), stderr: String((e as { stderr?: string }).stderr ?? '').slice(-2000) } })
    await prisma.job.update({ where: { id: job.id }, data: { status: 'failed', error: message.slice(0, 500), finishedAt: new Date() } })
    // Corte com erro não desfaz a aprovação; o resto vira 'failed'.
    if (job.type !== 'cuts') await prisma.project.update({ where: { id: job.projectId }, data: { status: 'failed' } })
  }
  return true
}

async function inputDuration(projectId: string) {
  // Tempo de cada etapa cresce com a duração pedida do vídeo.
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { targetDurationS: true } })
  return p?.targetDurationS ?? 0
}

console.log(`[worker] ${WORKER_ID} pronto`)
const check = () => checkClaude().catch((e) => console.warn('[worker] checagem do Claude:', e.message))
check()
setInterval(check, 2 * 60_000)
for (;;) {
  const worked = await runOne().catch((e) => { console.error('[worker]', e); return false })
  if (!worked) await new Promise((r) => setTimeout(r, 1000))
}
