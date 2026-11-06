import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logEvent, prisma } from '@corte/db'
import { BrainstormResult } from '@corte/shared'
import { googleSearch, researchKit, youtubeTop } from '@corte/providers'
import { askClaude } from './claude.js'
import { deadline } from './deadline.js'

// Aba Brainstorm: pega o próximo pedido na fila e traz ideias de vídeo para o nicho (com pesquisa na web).
export async function runNextBrainstorm() {
  const next = await prisma.brainstorm.findFirst({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' } })
  if (!next) return false
  const { count } = await prisma.brainstorm.updateMany({ where: { id: next.id, status: 'queued' }, data: { status: 'running', error: null, startedAt: new Date(), finishedAt: null, tokens: null } })
  if (!count) return true
  const dir = await mkdtemp(join(tmpdir(), 'darkviews-brainstorm-'))
  const startedAt = new Date()
  // shortcut: o worker faz uma coisa por vez, então o uso do Claude sem tarefa nesse intervalo é desta pesquisa; separar por id se um dia rodar em paralelo.
  const finish = async (data: object) => {
    const finishedAt = new Date()
    const u = await prisma.claudeUsageEvent.aggregate({ where: { jobId: null, createdAt: { gte: startedAt, lte: finishedAt } }, _sum: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true } })
    const tokens = (u._sum.inputTokens ?? 0) + (u._sum.outputTokens ?? 0) + (u._sum.cacheReadTokens ?? 0) + (u._sum.cacheWriteTokens ?? 0)
    await prisma.brainstorm.updateMany({ where: { id: next.id, status: 'running' }, data: { ...data, finishedAt, tokens } })
  }
  try {
    const kit = await researchKit(next.ownerId)
    const extra: string[] = []
    if (kit.youtube) {
      try {
        const top = await youtubeTop(kit.youtube, next.niche)
        if (top.length) extra.push(`Vídeos do nicho com mais visualizações no último ano (YouTube):\n${top.map((v: { title: string; channel: string; views: number; published: string }) => `- "${v.title}" — ${v.channel}, ${v.views.toLocaleString('pt-BR')} visualizações, ${v.published}`).join('\n')}\nUse isso para ver o que já funciona e achar ângulos que ainda faltam.`)
      } catch (e) { logEvent({ level: 'warn', source: 'worker', kind: 'integration', message: `youtube_data: ${(e as Error).message}` }) }
    }
    if (kit.google) {
      try {
        const hits = await googleSearch(kit.google, next.niche)
        if (hits.length) extra.push(`Resultados do Google sobre o nicho:\n${hits.map((h) => `- ${h}`).join('\n')}`)
      } catch (e) { logEvent({ level: 'warn', source: 'worker', kind: 'integration', message: `serper_search: ${(e as Error).message}` }) }
    }
    const out = await deadline(askClaude({
      jobId: '', cwd: dir, research: kit.web, effort: 'high', maxTurns: 30, schema: BrainstormResult,
      prompt: [
        `Você é estrategista de conteúdo do YouTube. Traga 10 ideias de vídeo para o nicho: "${next.niche}".`,
        next.notes ? `Observações de quem pediu:\n"""\n${next.notes}\n"""` : '',
        ...extra,
        kit.web ? 'Antes, pesquise na web (WebSearch/WebFetch): o que esse público procura, perguntas frequentes, polêmicas, histórias e assuntos em alta agora, e o que os canais desse nicho que mais crescem estão publicando.' : 'Use o que você já sabe sobre esse público e esse nicho.',
        'Cada ideia precisa ser específica (nada genérico como "dicas de X"), com título forte, gancho para os primeiros 5 segundos, ângulo, por que funciona, duração sugerida e tópicos do roteiro. Misture formatos: história, lista, explicação, polêmica, curiosidades, bastidores.',
        'Responda em português do Brasil.',
      ].filter(Boolean).join('\n\n'),
    }), 20)
    await finish({ status: 'done', ideas: JSON.stringify(out) })
  } catch (e) {
    const message = (e as Error).message
    logEvent({ level: 'error', source: 'worker', kind: 'job', message: `brainstorm falhou: ${message}`, details: { brainstormId: next.id } })
    await finish({ status: 'failed', error: message.slice(0, 500) })
  } finally { await rm(dir, { recursive: true, force: true }) }
  return true
}
