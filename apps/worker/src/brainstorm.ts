import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logEvent, prisma } from '@corte/db'
import { BrainstormResult } from '@corte/shared'
import { askClaude } from './claude.js'

// Aba Brainstorm: pega o próximo pedido na fila e traz ideias de vídeo para o nicho (com pesquisa na web).
export async function runNextBrainstorm() {
  const next = await prisma.brainstorm.findFirst({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' } })
  if (!next) return false
  const { count } = await prisma.brainstorm.updateMany({ where: { id: next.id, status: 'queued' }, data: { status: 'running', error: null } })
  if (!count) return true
  const dir = await mkdtemp(join(tmpdir(), 'darkviews-brainstorm-'))
  try {
    const out = await askClaude({
      jobId: '', cwd: dir, research: true, effort: 'high', maxTurns: 30, schema: BrainstormResult,
      prompt: [
        `Você é estrategista de conteúdo do YouTube. Traga 10 ideias de vídeo para o nicho: "${next.niche}".`,
        next.notes ? `Observações de quem pediu:\n"""\n${next.notes}\n"""` : '',
        'Antes, pesquise na web (WebSearch/WebFetch): o que esse público procura, perguntas frequentes, polêmicas, histórias e assuntos em alta agora, e o que os canais desse nicho que mais crescem estão publicando.',
        'Cada ideia precisa ser específica (nada genérico como "dicas de X"), com título forte, gancho para os primeiros 5 segundos, ângulo, por que funciona, duração sugerida e tópicos do roteiro. Misture formatos: história, lista, explicação, polêmica, curiosidades, bastidores.',
        'Responda em português do Brasil.',
      ].filter(Boolean).join('\n\n'),
    })
    await prisma.brainstorm.update({ where: { id: next.id }, data: { status: 'done', ideas: JSON.stringify(out) } })
  } catch (e) {
    const message = (e as Error).message
    logEvent({ level: 'error', source: 'worker', kind: 'job', message: `brainstorm falhou: ${message}`, details: { brainstormId: next.id } })
    await prisma.brainstorm.update({ where: { id: next.id }, data: { status: 'failed', error: message.slice(0, 500) } })
  } finally { await rm(dir, { recursive: true, force: true }) }
  return true
}
