import { prisma } from '@corte/db'

export const CANCELED = 'Parado por você'
// A pessoa clicou em Cancelar: para no próximo ponto seguro (cada cena, cada corte), sem esperar a etapa inteira.
export async function checkCancel(jobId: string) {
  if ((await prisma.job.findUnique({ where: { id: jobId }, select: { error: true } }))?.error === CANCELED) throw new Error(CANCELED)
}
