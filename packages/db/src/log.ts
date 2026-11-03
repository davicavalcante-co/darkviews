import { prisma } from './index.js'

export type LogEntry = { level?: 'info' | 'warn' | 'error'; source: 'api' | 'worker' | 'mcp'; kind: string; message: string; details?: Record<string, unknown>; userId?: string | null }

let writes = 0
// Grava sem bloquear quem chamou; um log que falha não pode derrubar a aplicação.
export function logEvent(e: LogEntry) {
  prisma.systemLog.create({
    data: { level: e.level ?? 'info', source: e.source, kind: e.kind, message: e.message.slice(0, 500), details: JSON.stringify(e.details ?? {}).slice(0, 8000), userId: e.userId ?? null },
  }).catch(() => {})
  // shortcut: limpeza simples a cada 500 gravações (30 dias); trocar por rotação de arquivo se o volume crescer muito.
  if (++writes % 500 === 0) prisma.systemLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * 86_400_000) } } }).catch(() => {})
}
