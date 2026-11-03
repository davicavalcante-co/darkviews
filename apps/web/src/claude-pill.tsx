import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { compact, num, type ClaudeBlock } from './dashboard'

const PLAN_NAMES: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' }

function left(to: string | null | undefined, now: number) {
  if (!to) return null
  const ms = new Date(to).getTime() - now
  if (ms <= 0) return null
  const h = Math.floor(ms / 3600_000), m = Math.floor((ms % 3600_000) / 60_000)
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`
}

// Uso do Claude em uma linha, flutuando no topo direito de todas as telas. Clicar abre os detalhes.
export function ClaudePill({ isAdmin }: { isAdmin: boolean }) {
  const [c, setC] = useState<ClaudeBlock | null>(null)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const load = () => api<ClaudeBlock>('/claude/usage').then(setC).catch(() => {})
    load()
    const poll = setInterval(load, 60_000)
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => { clearInterval(poll); clearInterval(tick) }
  }, [])
  // Fecha ao clicar fora ou apertar Esc.
  useEffect(() => {
    if (!open) return
    const out = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    addEventListener('mousedown', out); addEventListener('keydown', esc)
    return () => { removeEventListener('mousedown', out); removeEventListener('keydown', esc) }
  }, [open])
  if (!c) return null

  const state = !c.connected ? 'off' : c.available === false ? 'off' : c.available ? 'on' : ''
  const status = !c.connected ? 'Não conectado' : c.available === false ? 'Indisponível' : 'Claude'
  const sessionLeft = left(c.sessionResetsAt, now)
  const session = sessionLeft && c.sessionLeftPct != null ? Math.round(c.sessionLeftPct) : null
  const weekOk = c.weekResetsAt && new Date(c.weekResetsAt).getTime() > now
  const week = weekOk && c.weekLeftPct != null ? Math.round(c.weekLeftPct) : null
  const plan = c.subscription ? PLAN_NAMES[c.subscription] ?? c.subscription : c.plan?.name
  const meter = (pct: number | null) => <span className="meter" aria-hidden="true"><span style={{ width: `${pct ?? 0}%` }} className={pct != null && pct <= 20 ? 'low' : ''} /></span>

  return (
    <div className="pill-dock" ref={ref}>
      <button type="button" className="usage-pill" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}
        aria-label={`Uso do Claude: ${status}${session != null ? `, sessão ${session}% restante` : ''}${week != null ? `, semana ${week}% restante` : ''}`}>
        <span className={`dot ${state}`} />
        <strong>{status}</strong>
        {plan && <span className="pill-plan">{plan}</span>}
        {isAdmin && c.connected && <>
          <span className="sep" />
          <span className="pill-metric" title="Limite do plano, janela de 5 h (o chat do Claude usa a mesma cota)">Sessão {meter(session)} <b>{session != null ? `${session}%` : '—'}</b></span>
          {sessionLeft && <span className="pill-muted">↻ {sessionLeft}</span>}
          <span className="sep" />
          <span className="pill-metric" title="Limite do plano, janela de 7 dias (compartilhada com o chat)">Semana {meter(week)} <b>{week != null ? `${week}%` : '—'}</b></span>
          <span className="sep hide-sm" />
          <span className="pill-metric hide-sm" title="Tokens gastos hoje no Claude Code desta máquina">Claude Code hoje <b>{compact(c.tokens?.today ?? 0)}</b></span>
        </>}
      </button>

      {open && (
        <div className="pill-pop" role="dialog" aria-label="Uso do Claude">
          {c.warnings.map((w) => <p key={w.text} className={w.level === 'red' ? 'alert' : 'warn'}>{w.text}</p>)}
          {!c.connected && <p className="muted">{isAdmin ? 'Conecte o Claude no Painel para criar vídeos.' : 'Peça ao administrador para conectar o Claude.'}</p>}
          {isAdmin && c.connected ? (
            <dl className="pop-grid">
              {c.account?.email && <><dt>Conta</dt><dd>{c.account.email}</dd></>}
              <dt>Plano</dt><dd>{plan ?? '—'}{c.plan?.daysLeft != null ? ` · renova em ${c.plan.daysLeft} dias` : ''}</dd>
              <dt className="pop-sec">Limite do plano</dt><dd className="pop-sec muted">compartilhado com o chat</dd>
              <dt>Sessão (5 h)</dt><dd>{session != null ? `${session}% restante · reinicia em ${sessionLeft}` : 'sem dados ainda'}</dd>
              <dt>Semana</dt><dd>{week != null ? `${week}% restante · reinicia em ${new Date(c.weekResetsAt!).toLocaleDateString('pt-BR')}` : 'sem dados ainda'}</dd>
              <dt className="pop-sec">Claude Code</dt><dd className="pop-sec muted">tokens desta máquina</dd>
              <dt>Hoje</dt><dd>{num(c.tokens?.today ?? 0)}</dd>
              <dt>Na sessão atual</dt><dd>{num(c.tokens?.session ?? 0)}</dd>
              <dt>No mês</dt><dd>{num(c.tokens?.month ?? 0)}</dd>
              <dt>Do Corte Final no mês</dt><dd>{num(c.tokensApp?.month ?? 0)}</dd>
            </dl>
          ) : c.connected && <p className="muted">{c.available === false ? 'Os vídeos voltam a ser criados sozinhos quando o Claude estiver disponível.' : 'Tudo certo para criar vídeos.'}</p>}
          {isAdmin && !c.plan?.renewsAt && <a href="#/admin" onClick={() => setOpen(false)}>Informar a data de renovação do plano</a>}
          <small className="muted">Percentuais: limite do plano, lido do Claude a cada 2 minutos. Tokens: histórico local do Claude Code (só os números de uso) mais as chamadas do Corte Final.</small>
        </div>
      )}
    </div>
  )
}
