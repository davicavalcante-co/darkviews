import { useEffect, useState } from 'react'
import type { PublicUser } from '@corte/shared'
import { api, uploadFont } from './api'
import { PageHead } from './ui'

const TABS = [['users', 'Usuários'], ['fonts', 'Fontes'], ['audit', 'Auditoria'], ['logs', 'Logs']] as const
type Tab = (typeof TABS)[number][0]

async function act(fn: () => Promise<unknown>, after: () => unknown) {
  try { await fn(); await after() } catch (e) { alert((e as Error).message) }
}

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('users')
  return (
    <div className="page">
      <PageHead kicker="Configurações do sistema" title="Admin" />
      <div className="stack">
        <div className="tabs" role="tablist">
          {TABS.map(([t, label]) => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{label}</button>)}
        </div>
        {tab === 'users' && <Users />}
        {tab === 'fonts' && <Fonts />}
        {tab === 'audit' && <Audit />}
        {tab === 'logs' && <Logs />}
      </div>
    </div>
  )
}

type AdminUser = PublicUser & { status: string; lastLoginAt: string | null }

function Users() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const load = () => api<AdminUser[]>('/admin/users').then(setUsers)
  useEffect(() => { load() }, [])
  const patch = (id: string, body: object) => act(() => api(`/admin/users/${id}`, { method: 'PATCH', body }), load)

  return (
    <div className="cards">
      <div className="panel wide"><span className="panel-title">Conta deste computador</span><div className="table-wrap"><table>
        <thead><tr><th>Nome</th><th>E-mail</th><th>Status</th><th>Último acesso</th></tr></thead>
        <tbody>{users.map((u) => (
          <tr key={u.id}>
            <td>{u.name}</td><td>{u.email}</td>
            <td><select value={u.status} aria-label={`Status de ${u.name}`} onChange={(e) => patch(u.id, { status: e.target.value })}>
              <option value="active">Ativo</option><option value="disabled">Desativado</option></select></td>
            <td className="muted">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('pt-BR') : 'nunca'}</td>
          </tr>))}
        </tbody>
      </table></div></div>
    </div>
  )
}

function Fonts() {
  const [fonts, setFonts] = useState<{ family: string; enabled: boolean }[]>([])
  const [family, setFamily] = useState('')
  const load = () => api<typeof fonts>('/admin/fonts').then(setFonts)
  useEffect(() => { load() }, [])
  return (
    <div className="panel">
      <span className="panel-title">Fontes do Google · {fonts.filter((f) => f.enabled).length} liberadas</span>
      <p className="muted">Só as fontes liberadas aparecem para os usuários em Novo vídeo e na edição da legenda.</p>
      <div className="grid">{fonts.map((f) => (
        <label key={f.family} className="check">
          <input type="checkbox" checked={f.enabled} onChange={(e) => act(() => api(`/admin/fonts/${encodeURIComponent(f.family)}`, { method: 'PUT', body: { enabled: e.target.checked } }), load)} />
          {f.family}
        </label>))}
      </div>
      <div className="regen">
        <input placeholder="Nome exato no Google Fonts, ex.: Oswald" value={family} onChange={(e) => setFamily(e.target.value)} maxLength={60} />
        <button type="button" disabled={!family.trim()} onClick={() => act(() => api('/admin/fonts', { method: 'POST', body: { family } }), () => { setFamily(''); return load() })}>Liberar fonte</button>
      </div>
      <label className="btn ghost upload-btn">Enviar arquivo de fonte (.ttf ou .otf)
        <input type="file" accept=".ttf,.otf,font/ttf,font/otf" hidden onChange={(e) => {
          const f = e.target.files?.[0]; e.target.value = ''
          if (f) act(() => uploadFont(f), load)
        }} />
      </label>
    </div>
  )
}

type AuditRow = { id: string; createdAt: string; actor: string; action: string; targetType: string; targetId: string | null; details: Record<string, unknown>; ip: string }

function Audit() {
  const [rows, setRows] = useState<AuditRow[]>([])
  useEffect(() => { api<AuditRow[]>('/admin/audit?limit=200').then(setRows) }, [])
  return (
    <div className="panel"><span className="panel-title">Últimas {rows.length} ações</span><div className="table-wrap"><table>
      <thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Alvo</th><th>Detalhes</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}>
          <td className="muted">{new Date(r.createdAt).toLocaleString('pt-BR')}</td>
          <td>{r.actor}</td><td><code>{r.action}</code></td><td>{r.targetType}{r.targetId ? ` · ${r.targetId.slice(0, 8)}` : ''}</td>
          <td className="details">{JSON.stringify(r.details)}</td>
        </tr>))}
      </tbody>
    </table></div></div>
  )
}

type LogRow = { id: string; createdAt: string; level: 'info' | 'warn' | 'error'; source: string; kind: string; message: string; details: Record<string, unknown>; user: string | null }
const LEVELS = [['', 'Todos'], ['error', 'Erros'], ['warn', 'Avisos'], ['info', 'Info']] as const
const KINDS = [['', 'Tudo'], ['request', 'Requisições'], ['job', 'Jobs'], ['claude', 'Claude'], ['integration', 'Integrações'], ['auth', 'Login'], ['error', 'Erros da API']] as const

// Registro técnico de tudo que entra, sai e falha no sistema (só admin).
function Logs() {
  const [rows, setRows] = useState<LogRow[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [level, setLevel] = useState('')
  const [kind, setKind] = useState('')
  const [source, setSource] = useState('')
  const [q, setQ] = useState('')
  const [live, setLive] = useState(true)
  const [open, setOpen] = useState<string | null>(null)
  const query = (before?: string) => {
    const p = new URLSearchParams({ limit: '100' })
    if (level) p.set('level', level); if (kind) p.set('kind', kind); if (source) p.set('source', source); if (q) p.set('q', q)
    if (before) p.set('before', before)
    return api<{ rows: LogRow[]; last24h: Record<string, number> }>(`/admin/logs?${p}`)
  }
  const load = () => query().then((r) => { setRows(r.rows); setCounts(r.last24h) })
  useEffect(() => { load() }, [level, kind, source, q])
  useEffect(() => {
    if (!live) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [live, level, kind, source, q])
  const more = () => query(rows.at(-1)?.createdAt).then((r) => setRows([...rows, ...r.rows]))

  return (
    <div className="stack">
      <div className="tiles">
        <div className="tile"><span className="label">Erros · 24 h</span><strong className={counts.error ? 'err' : ''}>{counts.error ?? 0}</strong></div>
        <div className="tile"><span className="label">Avisos · 24 h</span><strong>{counts.warn ?? 0}</strong></div>
        <div className="tile"><span className="label">Eventos · 24 h</span><strong>{(counts.info ?? 0) + (counts.warn ?? 0) + (counts.error ?? 0)}</strong></div>
      </div>
      <div className="panel">
        <div className="log-filters">
          <div className="seg" role="group" aria-label="Nível">{LEVELS.map(([v, l]) => <button key={v} type="button" aria-pressed={level === v} onClick={() => setLevel(v)}>{l}</button>)}</div>
          <select className="chip" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Tipo">{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select className="chip" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Origem"><option value="">API e worker</option><option value="api">API</option><option value="worker">Worker</option></select>
          <input className="search" type="search" placeholder="Buscar no log" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar no log" />
          <label className="check"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Ao vivo</label>
        </div>
        <div className="log-list" role="log" aria-live="off">
          {rows.length === 0 && <p className="muted">Nenhum registro com esses filtros.</p>}
          {rows.map((r) => (
            <div key={r.id} className={`log-row lv-${r.level}`}>
              <button type="button" className="log-line" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                <time>{new Date(r.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                <span className="lv">{r.level === 'error' ? 'ERRO' : r.level === 'warn' ? 'AVISO' : 'INFO'}</span>
                <span className="src">{r.source}·{r.kind}</span>
                <span className="msg">{r.message}</span>
                {r.user && <span className="who-log">{r.user}</span>}
              </button>
              {open === r.id && <pre className="log-details">{JSON.stringify(r.details, null, 2)}</pre>}
            </div>
          ))}
        </div>
        {rows.length >= 100 && <button type="button" className="link" onClick={more}>Carregar mais</button>}
      </div>
    </div>
  )
}
