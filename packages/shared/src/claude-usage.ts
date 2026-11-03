import { z } from 'zod'

// Motivo gravado em claude_status.reason quando o Claude não está disponível.
export type ClaudeReason = 'rate_limit' | 'overloaded' | 'no_login' | 'offline' | null
export type ClaudeSnapshot = {
  checkedAt: string | Date; available: boolean; reason: string | null
  sessionUsedPct: number | null; sessionResetsAt: string | Date | null
  weekUsedPct: number | null; weekResetsAt: string | Date | null
}
export type Warning = { level: 'red' | 'yellow'; text: string; adminOnly?: boolean }

const hm = (d: string | Date) => new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
const dm = (d: string | Date) => new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })

export const SESSION_WARN_PCT = 80
export const WEEK_WARN_PCT = 90

// Avisos do Painel (tabela "Avisos que o Painel deve mostrar" do SPEC).
export function claudeWarnings(s: ClaudeSnapshot | null, isAdmin: boolean): Warning[] {
  if (!s) return []
  const w: Warning[] = []
  if (!s.available) {
    if (s.reason === 'rate_limit') w.push({ level: 'red', text: `Claude indisponível${s.sessionResetsAt ? ` até ${hm(s.sessionResetsAt)}` : ''} (limite da sessão). Os vídeos voltam sozinhos no horário de reinício.` })
    else if (s.reason === 'overloaded') w.push({ level: 'yellow', text: 'Claude sobrecarregado. Nova tentativa em 1 min.' })
    else if (s.reason === 'offline') w.push({ level: 'red', text: 'Sem conexão. Os vídeos voltam a ser criados quando a internet voltar.' })
    else if (s.reason === 'no_login') w.push({ level: 'red', text: 'Faça login no Claude Code neste computador.', adminOnly: true })
  }
  if (s.sessionUsedPct != null && s.sessionUsedPct >= SESSION_WARN_PCT && s.available) {
    w.push({ level: 'yellow', text: `Sessão do Claude em ${Math.round(s.sessionUsedPct)}%.${s.sessionResetsAt ? ` Reinicia às ${hm(s.sessionResetsAt)}.` : ''} Novos vídeos longos ficam na fila.` })
  }
  if (s.weekUsedPct != null && s.weekUsedPct >= WEEK_WARN_PCT) {
    w.push({ level: 'yellow', text: `Limite semanal do Claude em ${Math.round(s.weekUsedPct)}%.${s.weekResetsAt ? ` Reinicia em ${dm(s.weekResetsAt)}.` : ''}` })
  }
  return w.filter((x) => isAdmin || !x.adminOnly)
}

// ---------- Plano e limites (tabela settings, editada só pelo admin) ----------
export const SettingsInput = z.object({
  plan_name: z.string().trim().max(60).default(''),
  plan_renews_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal('')).default(''),
  max_duration_s: z.coerce.number().int().min(15).max(1080),
  daily_video_limit: z.coerce.number().int().min(0).max(1000), // 0 = sem limite
})
export type Settings = z.infer<typeof SettingsInput>
export const DEFAULT_SETTINGS: Settings = { plan_name: '', plan_renews_at: '', max_duration_s: 1080, daily_video_limit: 0 }

export const FontInput = z.object({ family: z.string().trim().min(2).max(60).regex(/^[A-Za-z0-9 ]+$/, 'Nome de fonte inválido') })
export const FontToggle = z.object({ enabled: z.boolean() })
