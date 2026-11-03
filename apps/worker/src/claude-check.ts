import { prisma } from '@corte/db'
import { SESSION_WARN_PCT } from '@corte/shared'
import { recordStatus } from './claude.js'
import { run } from './ffmpeg.js'

// Teste leve (sem gastar tokens): internet até a API e login do Claude Code. Roda a cada 2 minutos.
export async function checkClaude() {
  try {
    await fetch('https://api.anthropic.com', { method: 'HEAD', signal: AbortSignal.timeout(10_000) })
  } catch {
    return recordStatus({ available: false, reason: 'offline' })
  }
  try {
    const { stdout } = await run('claude', ['auth', 'status'], { timeout: 20_000 })
    if (!JSON.parse(stdout).loggedIn && !process.env.CLAUDE_CODE_OAUTH_TOKEN) return recordStatus({ available: false, reason: 'no_login' })
  } catch { /* CLI fora do PATH: o Agent SDK usa o próprio executável; os erros reais dos jobs dizem o resto */ }
  const last = await prisma.claudeStatus.findFirst({ orderBy: { checkedAt: 'desc' } })
  // Limite atingido continua valendo até o horário de reinício.
  if (last?.reason === 'rate_limit' && last.sessionResetsAt && last.sessionResetsAt > new Date()) return
  await recordStatus({ available: true, reason: null })
}

// Sessão perto do limite: vídeos longos (mais de 5 min) esperam o reinício para não estourar no meio.
export async function holdLongVideo(projectId: string) {
  const s = await prisma.claudeStatus.findFirst({ orderBy: { checkedAt: 'desc' } })
  if (!s?.sessionUsedPct || s.sessionUsedPct < SESSION_WARN_PCT || !s.sessionResetsAt || s.sessionResetsAt <= new Date()) return null
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { targetDurationS: true } })
  return p && p.targetDurationS > 300 ? s.sessionResetsAt : null
}
