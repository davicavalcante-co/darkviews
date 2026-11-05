import { useEffect, useState } from 'react'
import type { Warning } from '@corte/shared'
import { api } from './api'
import { Donut, LineChart } from './charts'
import { PageHead, Section } from './ui'
import { ClaudeLink } from './claude-connect'

export type ClaudeBlock = {
  connected: boolean
  available: boolean | null; checkedAt: string | null; warnings: Warning[]
  account?: { email: string | null; organization: string | null }
  subscription?: string | null
  tokens?: { today: number; session: number; month: number }
  tokensApp?: { month: number }
  sessionLeftPct?: number | null; sessionResetsAt?: string | null; weekLeftPct?: number | null; weekResetsAt?: string | null
  plan?: { name: string | null; renewsAt: string | null; daysLeft: number | null }
  byModel?: { model: string; tokens: number }[]
  history?: { day: string; tokens: number }[]
}
type Dash = {
  production: { analyzing: number; creating: number; imageReview?: number; editing: number; inApproval: number; approved: number; failed: number; cuts: number; weeks: { start: string; count: number }[] }
  claude: ClaudeBlock
}

export const num = (n: number) => n.toLocaleString('pt-BR')
export const compact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`
  : n >= 1000 ? `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : String(n)
const MODEL_NAMES: Record<string, string> = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5', 'claude-fable-5-1': 'Fable 5.1' }
const day = (s: string) => new Date(s).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })

// Primeiro acesso: conecta o Claude Code desta máquina. O admin autoriza no site do Claude e cola o código aqui.
function ConnectClaude({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function step(fn: () => Promise<void>) {
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="connect">
      <div className="connect-copy">
        <span className="kicker">Primeiro acesso</span>
        <h2>Conecte o Claude para criar vídeos</h2>
        <p className="muted">O Darkviews usa o Claude deste computador para analisar referências e escrever os roteiros. Entre com a conta do seu plano (Pro ou Max): a autorização acontece no site do Claude.</p>
      </div>
      <div className="connect-steps">
        {!url ? (
          <button type="button" disabled={busy} onClick={() => step(async () => {
            const r = await api<{ url: string }>('/admin/claude/connect', { method: 'POST' })
            setUrl(r.url); window.open(r.url, '_blank', 'noopener')
          })}>{busy ? 'Abrindo…' : 'Conectar ao Claude'}</button>
        ) : (
          <>
            <p><strong>1.</strong> Autorize na página do Claude que abriu. <a href={url} target="_blank" rel="noopener noreferrer">Abrir de novo</a></p>
            <label><strong>2.</strong> Cole o código que o site mostrar
              <input value={code} onChange={(e) => setCode(e.target.value.trim())} placeholder="Código de autorização" autoComplete="off" spellCheck={false} />
            </label>
            <div className="row">
              <button type="button" className="link" onClick={() => step(async () => { await api('/admin/claude/cancel', { method: 'POST' }); setUrl(null); setCode('') })}>Cancelar</button>
              <button type="button" disabled={busy || code.length < 10} onClick={() => step(async () => { await api('/admin/claude/code', { method: 'POST', body: { code } }); onDone() })}>
                {busy ? 'Conectando…' : 'Concluir conexão'}
              </button>
            </div>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </div>
  )
}

function Tile({ label, value, hint, accent }: { label: string; value: string | number; hint?: string | null; accent?: boolean }) {
  return (
    <div className={`tile${accent ? ' accent' : ''}`}>
      <span className="label">{label}</span>
      <div><strong>{value}</strong>{hint && <small>{hint}</small>}</div>
    </div>
  )
}

export function Dashboard({ isAdmin }: { isAdmin: boolean }) {
  const [d, setD] = useState<Dash | null>(null)
  const load = () => api<Dash>('/dashboard').then(setD).catch(() => {})
  useEffect(() => {
    load()
    const poll = setInterval(load, 30_000)
    return () => clearInterval(poll)
  }, [])
  if (!d) return null
  const p = d.production, c = d.claude
  const statusSlices = [
    { key: 'analyzing', label: 'Em análise', value: p.analyzing },
    { key: 'creating', label: 'Criando', value: p.creating },
    { key: 'editing', label: 'Em edição', value: p.editing },
    { key: 'inApproval', label: 'Aguardando aprovação', value: p.inApproval },
    { key: 'approved', label: 'Aprovados', value: p.approved },
    { key: 'failed', label: 'Com falha', value: p.failed },
  ]

  return (
    <div className="page">
      <PageHead kicker={new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })} title="Painel">
        <a className="btn" href="#/novo">+ Novo vídeo</a>
      </PageHead>

      {!c.connected && (isAdmin
        ? <ConnectClaude onDone={load} />
        : <p className="warn" role="status">O Claude ainda não está conectado neste computador. Peça ao administrador para conectar no Painel.</p>)}

      {c.connected && isAdmin && <ClaudeLink />}

      {c.warnings.length > 0 && (
        <div className="notice-list">{c.warnings.map((w) => <p key={w.text} className={w.level === 'red' ? 'alert' : 'warn'} role="status">{w.text}</p>)}</div>
      )}

      <Section idx={1} title="Produção" aside={isAdmin ? 'todos os projetos' : 'seus projetos'}>
        <div className="tiles">
          <Tile label="Em análise" value={p.analyzing} />
          <Tile label="Criando" value={p.creating} hint={p.imageReview ? `${p.imageReview} esperando você aprovar imagens` : null} />
          <Tile label="Em edição" value={p.editing} />
          <Tile label="Aguardando aprovação" value={p.inApproval} />
          <Tile label="Aprovados" value={p.approved} hint={p.failed ? `${p.failed} com falha` : null} />
          <Tile label="Cortes gerados" value={p.cuts} accent />
        </div>
      </Section>

      <Section idx={2} title="Tendências" aside="o uso do Claude fica na barra do topo">
        <div className="cards">
          <div className="panel wide">
            <div className="row"><h3 className="panel-title">Entregas por semana</h3><span className="muted">{p.weeks.reduce((n, w) => n + w.count, 0)} em 8 semanas</span></div>
            <LineChart label="Vídeos aprovados por semana nas últimas 8 semanas" empty="Nenhuma entrega nas últimas 8 semanas."
              points={p.weeks.map((w) => ({ key: w.start, label: day(w.start), value: w.count, title: `Semana de ${day(w.start)}: ${w.count}` }))} />
          </div>
          <div className="panel">
            <h3 className="panel-title">Projetos por etapa</h3>
            <Donut label="Projetos por etapa" center="projetos" empty="Nenhum projeto ainda." slices={statusSlices} />
          </div>
        </div>
        {/* Segunda linha da grade: consumo do Claude (só admin), mesmo par linha + pizza */}
        <div className="cards">
          {c.history && (
            <div className="panel wide">
              <div className="row"><h3 className="panel-title">Tokens do Claude Code por dia</h3><span className="muted">últimos 14 dias</span></div>
              <LineChart label="Tokens usados por dia nos últimos 14 dias" empty="Nenhum token usado nos últimos 14 dias." format={compact}
                points={c.history.map((h, i) => ({ key: h.day, label: i % 2 ? '' : day(`${h.day}T12:00`), value: h.tokens, title: `${day(`${h.day}T12:00`)}: ${num(h.tokens)} tokens` }))} />
            </div>
          )}
          {c.byModel && (
            <div className="panel">
              <h3 className="panel-title">Tokens do Claude Code por modelo</h3>
              <Donut label="Tokens por modelo nos últimos 30 dias" center="tokens · 30 dias" empty="Nenhum token nos últimos 30 dias." format={compact}
                slices={c.byModel.map((m) => ({ key: m.model, label: MODEL_NAMES[m.model] ?? m.model, value: m.tokens }))} />
            </div>
          )}
        </div>
      </Section>
    </div>
  )
}
