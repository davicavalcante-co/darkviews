import { hostname } from 'node:os'
import { afterScript } from '@corte/shared'
import { prisma, claimNextJob, estimateSeconds, logEvent, type Job } from '@corte/db'
import { ingest } from './ingest.js'
import { analyze } from './analyze.js'
import { script } from './script.js'
import { media, voice } from './media-job.js'
import { render } from './render.js'
import { regenPart } from './regen-part.js'
import { cuts } from './cuts.js'
import { montage } from './montage.js'
import { runNextAnalysis } from './video-analysis.js'
import { runNextBrainstorm } from './brainstorm.js'
import { deadline } from './deadline.js'
import { ClaudeUnavailable, recordStatus } from './claude.js'
import { checkClaude, holdLongVideo } from './claude-check.js'

const WORKER_ID = `${hostname()}:${process.pid}`
const HANDLERS: Record<string, (job: Job) => Promise<void>> = { ingest, analyze, script, media, voice, render, regen_part: regenPart, cuts, montage }

// Jobs "running" de um worker que caiu ficam presos; ao iniciar, devolvemos para a fila só os de processos mortos
// (outra cópia do sistema ligada ainda está trabalhando nos dela).
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }
const stuck = await prisma.job.findMany({ where: { status: 'running', lockedBy: { startsWith: hostname() + ':' } }, select: { id: true, lockedBy: true } })
const dead = stuck.filter((j) => !alive(Number(j.lockedBy!.split(':').pop()))).map((j) => j.id)
if (dead.length) await prisma.job.updateMany({ where: { id: { in: dead }, status: 'running' }, data: { status: 'queued', lockedBy: null } })
// Análises e brainstorms interrompidos (sistema desligado no meio) voltam para a fila e recomeçam sozinhos.
// shortcut: supõe um worker por máquina (uma conta por máquina); guardar o dono como nos jobs se um dia rodar mais de um.
await prisma.videoAnalysis.updateMany({ where: { status: 'running' }, data: { status: 'queued', stage: 'Na fila (recomeçando)' } })
await prisma.brainstorm.updateMany({ where: { status: 'running' }, data: { status: 'queued' } })

// Aprovações sem resposta no prazo da rodada (10 min): aprova sozinho e segue. Roteiro → imagens; imagens → narração.
async function autoApprove() {
  // Cortes dos vídeos enviados sem resposta no prazo: todos aprovados e o vídeo é montado.
  for (const p of await prisma.project.findMany({ where: { status: 'cut_review', reviewUntil: { lte: new Date() } }, select: { id: true } })) {
    const moved = await prisma.$transaction(async (tx) => {
      const { count } = await tx.project.updateMany({ where: { id: p.id, status: 'cut_review' }, data: { status: 'media', reviewUntil: null } })
      if (!count) return 0
      await tx.asset.updateMany({ where: { projectId: p.id, kind: 'footage_cut' }, data: { kind: 'footage_clip' } })
      await tx.job.create({ data: { projectId: p.id, type: 'montage', stage: 'Na fila', payload: JSON.stringify({ assemble: true }) } })
      return count
    })
    if (moved) logEvent({ source: 'worker', kind: 'job', message: 'cortes aprovados automaticamente (prazo de 10 min esgotado)', details: { projectId: p.id } })
  }
  // Roteiro sem resposta no prazo: aprovado como está e segue para as imagens.
  for (const p of await prisma.project.findMany({ where: { status: 'script_review', reviewUntil: { lte: new Date() } }, select: { id: true, options: true } })) {
    const moved = await prisma.$transaction(async (tx) => {
      const { count } = await tx.project.updateMany({ where: { id: p.id, status: 'script_review' }, data: { status: 'media', reviewUntil: null } })
      if (count) await tx.job.create({ data: { projectId: p.id, type: afterScript(p.options), stage: 'Na fila' } })
      return count
    })
    if (moved) logEvent({ source: 'worker', kind: 'job', message: 'roteiro aprovado automaticamente (prazo de 10 min esgotado)', details: { projectId: p.id } })
  }
  const late = await prisma.project.findMany({ where: { status: 'image_review', reviewUntil: { lte: new Date() } }, select: { id: true, scripts: { orderBy: { version: 'desc' }, take: 1, select: { id: true } } } })
  for (const p of late) {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.project.updateMany({ where: { id: p.id, status: 'image_review' }, data: { status: 'media', reviewUntil: null } })
      if (!count) return
      const scenes = await tx.scene.findMany({ where: { scriptId: p.scripts[0]?.id ?? '', asset: { kind: { in: ['stock_image', 'stock_video'] } } }, select: { id: true, searchQuery: true } })
      for (const s of scenes) {
        const q = s.searchQuery ? JSON.parse(s.searchQuery) : {}
        if (q.approved !== true) await tx.scene.update({ where: { id: s.id }, data: { searchQuery: JSON.stringify({ ...q, approved: true }) } })
      }
      await tx.job.create({ data: { projectId: p.id, type: 'voice', stage: 'Na fila' } })
    })
    logEvent({ source: 'worker', kind: 'job', message: 'imagens aprovadas automaticamente (prazo de 10 min esgotado)', details: { projectId: p.id } })
  }
}

async function runOne() {
  await autoApprove()
  // Jobs pausados pelo limite do Claude voltam sozinhos para a fila no horário de reinício.
  await prisma.job.updateMany({ where: { status: 'paused', resumeAt: { lte: new Date() } }, data: { status: 'queued', resumeAt: null } })
  const job = await claimNextJob(WORKER_ID, Object.keys(HANDLERS))
  if (!job) return (await runNextAnalysis(null)) || runNextBrainstorm() // sem vídeo na fila: análises e brainstorms
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
    await deadline(HANDLERS[job.type](job), 480) // 8 h: vídeo de 60 min com voz própria cabe com folga
    // A pessoa pediu para parar: esta etapa termina, as seguintes que ela criou são canceladas e o vídeo fica como "Falhou".
    if ((await prisma.job.findUnique({ where: { id: job.id }, select: { error: true } }))?.error === 'Parado por você') {
      await prisma.job.updateMany({ where: { projectId: job.projectId, status: 'queued' }, data: { status: 'failed', error: 'Parado por você', finishedAt: new Date() } })
      await prisma.job.update({ where: { id: job.id }, data: { status: 'failed', finishedAt: new Date() } })
      await prisma.project.update({ where: { id: job.projectId }, data: { status: 'failed' } })
      return true
    }
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
