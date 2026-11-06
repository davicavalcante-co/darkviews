import { useEffect, useState, type FormEvent } from 'react'
import type { PublicUser } from '@corte/shared'
import { api, uploadFont } from './api'
import { PageHead } from './ui'
import { IdentityTab } from './identity'

const TABS = [['users', 'Perfil'], ['identity', 'Identidade'], ['fonts', 'Fontes'], ['audit', 'Auditoria'], ['logs', 'Logs']] as const
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
        {tab === 'users' && <Profile />}
        {tab === 'identity' && <IdentityTab />}
        {tab === 'fonts' && <Fonts />}
        {tab === 'audit' && <Audit />}
        {tab === 'logs' && <Logs />}
      </div>
    </div>
  )
}

// Perfil da conta deste computador: nome, sobrenome, e-mail e senha. A senha atual confirma a mudança.
function Profile() {
  const [me, setMe] = useState<PublicUser | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { api<{ user: PublicUser }>('/auth/me').then((r) => setMe(r.user)) }, [])
  if (!me) return null
  const [first, ...rest] = me.name.split(' ')
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>
    if (f.newPassword && f.newPassword !== f.confirm) return setMsg({ ok: false, text: 'A senha nova e a repetição não são iguais' })
    setBusy(true); setMsg(null)
    try {
      const r = await api<{ user: PublicUser }>('/me', { method: 'PUT', body: { firstName: f.firstName, lastName: f.lastName, email: f.email, currentPassword: f.currentPassword, newPassword: f.newPassword } })
      setMe(r.user); form.reset(); setMsg({ ok: true, text: 'Perfil salvo.' })
      dispatchEvent(new CustomEvent('profile-changed', { detail: r.user }))
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }) } finally { setBusy(false) }
  }
  return (
    <form className="panel profile" onSubmit={save} key={me.email + me.name}>
      <span className="panel-title">Meu perfil</span>
      <div className="profile-grid">
        <label>Nome<input name="firstName" required maxLength={60} defaultValue={first} autoComplete="given-name" /></label>
        <label>Sobrenome<input name="lastName" maxLength={60} defaultValue={rest.join(' ')} autoComplete="family-name" /></label>
        <label className="span2">E-mail<input name="email" type="email" required defaultValue={me.email} autoComplete="username" /></label>
        <label><span>Senha nova <em>deixe vazio para manter</em></span><input name="newPassword" type="password" minLength={10} autoComplete="new-password" /></label>
        <label><span>Repita a senha nova</span><input name="confirm" type="password" minLength={10} autoComplete="new-password" /></label>
        <label><span>Senha atual <em>para confirmar</em></span><input name="currentPassword" type="password" required autoComplete="current-password" /></label>
        <div className="profile-save"><button disabled={busy}>{busy ? 'Salvando…' : 'Salvar perfil'}</button></div>
      </div>
      {msg && <p className={msg.ok ? 'notice ok-box' : 'notice alert'} role="status">{msg.ok ? '✓' : '✕'} {msg.text}</p>}
    </form>
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
