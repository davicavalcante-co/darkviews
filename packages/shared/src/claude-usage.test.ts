import { describe, expect, it } from 'vitest'
import { claudeWarnings, type ClaudeSnapshot } from './claude-usage'

const base: ClaudeSnapshot = { checkedAt: new Date(), available: true, reason: null, sessionUsedPct: null, sessionResetsAt: null, weekUsedPct: null, weekResetsAt: null }

describe('avisos do Claude', () => {
  it('sem dados não gera aviso (e não vira zero)', () => {
    expect(claudeWarnings(base, true)).toEqual([])
    expect(claudeWarnings(null, true)).toEqual([])
  })
  it('sessão a partir de 80% e semana a partir de 90%', () => {
    const w = claudeWarnings({ ...base, sessionUsedPct: 85, sessionResetsAt: '2026-11-03T17:20:00Z', weekUsedPct: 92 }, false)
    expect(w.map((x) => x.text)).toEqual([
      'Sessão do Claude em 85%. Reinicia às 14:20. Novos vídeos longos ficam na fila.',
      expect.stringMatching(/^Limite semanal do Claude em 92%/),
    ])
    expect(claudeWarnings({ ...base, sessionUsedPct: 79, weekUsedPct: 89 }, true)).toEqual([])
  })
  it('limite, sobrecarga e falta de internet aparecem para todos; falta de login só para o admin', () => {
    expect(claudeWarnings({ ...base, available: false, reason: 'rate_limit', sessionResetsAt: '2026-11-03T17:20:00Z' }, false)[0].text).toBe('Claude indisponível até 14:20 (limite da sessão). Os vídeos voltam sozinhos no horário de reinício.')
    expect(claudeWarnings({ ...base, available: false, reason: 'overloaded' }, false)[0].level).toBe('yellow')
    expect(claudeWarnings({ ...base, available: false, reason: 'offline' }, false)).toHaveLength(1)
    expect(claudeWarnings({ ...base, available: false, reason: 'no_login' }, false)).toEqual([])
    expect(claudeWarnings({ ...base, available: false, reason: 'no_login' }, true)).toHaveLength(1)
  })
})
