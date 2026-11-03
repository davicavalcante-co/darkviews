import { prisma } from './index.js'

// Lock otimista: só quem conseguir trocar queued -> running fica com o job.
export async function claimNextJob(workerId: string, types: string[]) {
  const job = await prisma.job.findFirst({ where: { status: 'queued', type: { in: types } }, orderBy: { createdAt: 'asc' } })
  if (!job) return null
  const { count } = await prisma.job.updateMany({
    where: { id: job.id, status: 'queued' },
    data: { status: 'running', lockedBy: workerId, startedAt: new Date(), attempts: { increment: 1 } },
  })
  return count === 1 ? { ...job, status: 'running', lockedBy: workerId } : null
}

// shortcut: média simples dos últimos 20 jobs do tipo, proporcional à duração; refinar por etapa na Fase 4.
export async function estimateSeconds(jobType: string, inputDurationS: number) {
  const rows = await prisma.jobMetric.findMany({ where: { jobType }, orderBy: { createdAt: 'desc' }, take: 20 })
  if (!rows.length) return null
  const ratio = rows.reduce((s, r) => s + r.elapsedS / Math.max(r.inputDurationS, 1), 0) / rows.length
  return Math.round(ratio * Math.max(inputDurationS, 1))
}
