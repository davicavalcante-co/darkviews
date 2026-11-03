import { useEffect, useState } from 'react'
import type { Warning } from '@corte/shared'
import { api } from './api'

type Dash = {
  production: { analyzing: number; creating: number; editing: number; inApproval: number; approved: number; failed: number; cuts: number; weeks: { start: string; count: number }[] }
  claude: {
    available: boolean | null; checkedAt: string | null; warnings: Warning[]
    tokens?: { today: number; session: number; month: number }
    sessionLeftPct?: number | null; sessionResetsAt?: string | null; weekLeftPct?: number | null; weekResetsAt?: string | null
    plan?: { name: string | null; renewsAt: string | null; daysLeft: number | null }
    history?: { day: string; tokens: number }[]
  }
}

const num = (n: number) => n.toLocaleString('pt-BR')
function countdown(to: string | null | undefined, now: number) {
  if (!to) return null
  const ms = new Date(to).getTime() - now
  if (ms <= 0) return 'reiniciando'
  const h = Math.floor(ms / 3600_000), m = Math.floor((ms % 3600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000)
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min ${String(s).padStart(2, '0')} s`
}

function Tile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  // Texto ("sem dados ainda") fica menor que número, para não quebrar em várias linhas.
  const isText = typeof value === 'string' && /[a-z]/i.test(value)
  return <div className="tile"><span className="muted">{label}</span><strong className={isText ? 'text' : undefined}>{value}</strong>{hint && <small className="muted">{hint}</small>}</div>
}

function Bars({ data, label }: { data: { key: string; value: number; title: string }[]; label: string }) {
  const max = Math.max(1, ...data.map((d) => d.value))
  return (
    <div className="bars" role="img" aria-label={label}>
      {data.map((d) => <span key={d.key} title={d.title} style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }} />)}
    </div>
  )
}

export function Dashboard({ isAdmin }: { isAdmin: boolean }) {
  const [d, setD] = useState<Dash | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const load = () => api<Dash>('/dashboard').then(setD).catch(() => {})
    load()
    const poll = setInterval(load, 30_000)
    const tick = setInterval(() => setNow(Date.now()), 1000) // contagem regressiva no navegador a partir do valor salvo
    return () => { clearInterval(poll); clearInterval(tick) }
  }, [])
  if (!d) return null
  const p = d.production, c = d.claude
  const statusText = c.available == null ? 'sem dados ainda' : c.available ? 'disponível' : 'indisponível'

  return (
    <section className="stack">
      <h2>Painel</h2>
      {c.warnings.map((w) => <p key={w.text} className={w.level === 'red' ? 'alert' : 'warn'} role="status">{w.text}</p>)}

      <div className="tiles">
        <Tile label="Em análise" value={p.analyzing} />
        <Tile label="Criando" value={p.creating} />
        <Tile label="Em edição" value={p.editing} />
        <Tile label="Aguardando aprovação" value={p.inApproval} />
        <Tile label="Cortes gerados" value={p.cuts} />
        <Tile label="Aprovados" value={p.approved} hint={p.failed ? `${p.failed} com falha` : undefined} />
      </div>
      <div>
        <h3>Entregas por semana</h3>
        <Bars label="Vídeos aprovados por semana nas últimas 8 semanas"
          data={p.weeks.map((w) => ({ key: w.start, value: w.count, title: `Semana de ${new Date(w.start).toLocaleDateString('pt-BR')}: ${w.count}` }))} />
        <p className="muted">Últimas 8 semanas · total {p.weeks.reduce((n, w) => n + w.count, 0)}</p>
      </div>

      <div className="claude">
        <h3>Uso do Claude <span className={`dot ${c.available ? 'on' : c.available === false ? 'off' : ''}`} /> <small className="muted">{statusText}</small></h3>
        {isAdmin && c.tokens ? (
          <>
            <div className="tiles">
              <Tile label="Tokens hoje" value={num(c.tokens.today)} />
              <Tile label="Tokens na sessão" value={num(c.tokens.session)} />
              <Tile label="Tokens no mês" value={num(c.tokens.month)} />
              <Tile label="Restante da sessão (5 h)" value={c.sessionLeftPct == null ? 'sem dados ainda' : `${Math.round(c.sessionLeftPct)}%`}
                hint={countdown(c.sessionResetsAt, now) ? `reinicia em ${countdown(c.sessionResetsAt, now)}` : undefined} />
              <Tile label="Restante da semana" value={c.weekLeftPct == null ? 'sem dados ainda' : `${Math.round(c.weekLeftPct)}%`}
                hint={c.weekResetsAt ? `reinicia em ${new Date(c.weekResetsAt).toLocaleDateString('pt-BR')}` : undefined} />
              <Tile label={c.plan?.name ? `Plano ${c.plan.name}` : 'Plano'} value={c.plan?.daysLeft == null ? '—' : `${c.plan.daysLeft} dias`}
                hint={c.plan?.renewsAt ? 'até renovar' : 'informe a renovação em Admin → Plano e limites'} />
            </div>
            {c.history && (
              <>
                <h4>Tokens por dia (14 dias)</h4>
                <Bars label="Tokens usados por dia nos últimos 14 dias" data={c.history.map((h) => ({ key: h.day, value: h.tokens, title: `${h.day}: ${num(h.tokens)} tokens` }))} />
              </>
            )}
            <p className="muted">O Claude não informa "tokens restantes" em planos Pro e Max: o restante aparece em percentual da janela de 5 h e da semana.</p>
          </>
        ) : (
          <p className="muted">{c.available === false ? 'Os vídeos voltam a ser criados sozinhos quando o Claude estiver disponível.' : 'Tudo certo para criar vídeos.'}</p>
        )}
      </div>
    </section>
  )
}
