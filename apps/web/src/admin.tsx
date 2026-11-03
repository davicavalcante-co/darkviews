import { useEffect, useState, type FormEvent } from 'react'
import type { PublicUser, Settings } from '@corte/shared'
import { api } from './api'
import { Integrations } from './integrations'

const TABS = [['users', 'Usuários'], ['integrations', 'Integrações'], ['fonts', 'Fontes'], ['plan', 'Plano e limites'], ['audit', 'Auditoria']] as const
type Tab = (typeof TABS)[number][0]

async function act(fn: () => Promise<unknown>, after: () => unknown) {
  try { await fn(); await after() } catch (e) { alert((e as Error).message) }
}

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('users')
  return (
    <section>
      <h2>Admin</h2>
      <div className="tabs" role="tablist">
        {TABS.map(([t, label]) => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{label}</button>)}
      </div>
      {tab === 'users' && <Users />}
      {tab === 'integrations' && <Integrations />}
      {tab === 'fonts' && <Fonts />}
      {tab === 'plan' && <Plan />}
      {tab === 'audit' && <Audit />}
    </section>
  )
}

type AdminUser = PublicUser & { status: string; lastLoginAt: string | null }

function Users() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const load = () => api<AdminUser[]>('/admin/users').then(setUsers)
  useEffect(() => { load() }, [])
  const patch = (id: string, body: object) => act(() => api(`/admin/users/${id}`, { method: 'PATCH', body }), load)

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    await act(() => api('/admin/users', { method: 'POST', body: Object.fromEntries(new FormData(form)) }), () => { form.reset(); return load() })
  }

  return (
    <section className="stack">
      <div className="table-wrap"><table>
        <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Status</th><th>Último acesso</th></tr></thead>
        <tbody>{users.map((u) => (
          <tr key={u.id}>
            <td>{u.name}</td><td>{u.email}</td>
            <td><select value={u.role} aria-label={`Papel de ${u.name}`} onChange={(e) => patch(u.id, { role: e.target.value })}>
              <option value="user">Usuário</option><option value="admin">Admin</option></select></td>
            <td><select value={u.status} aria-label={`Status de ${u.name}`} onChange={(e) => patch(u.id, { status: e.target.value })}>
              <option value="active">Ativo</option><option value="disabled">Desativado</option></select></td>
            <td className="muted">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('pt-BR') : 'nunca'}</td>
          </tr>))}
        </tbody>
      </table></div>
      <form onSubmit={create}>
        <fieldset>
          <legend>Novo usuário</legend>
          <div className="grid">
            <label>Nome<input name="name" required maxLength={120} /></label>
            <label>E-mail<input name="email" type="email" required /></label>
            <label>Senha inicial (mín. 10)<input name="password" type="password" minLength={10} required autoComplete="new-password" /></label>
            <label>Papel<select name="role"><option value="user">Usuário</option><option value="admin">Admin</option></select></label>
          </div>
          <button>Criar usuário</button>
        </fieldset>
      </form>
    </section>
  )
}

function Fonts() {
  const [fonts, setFonts] = useState<{ family: string; enabled: boolean }[]>([])
  const [family, setFamily] = useState('')
  const load = () => api<typeof fonts>('/admin/fonts').then(setFonts)
  useEffect(() => { load() }, [])
  return (
    <section className="stack">
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
    </section>
  )
}

function Plan() {
  const [s, setS] = useState<Settings | null>(null)
  const [msg, setMsg] = useState('')
  useEffect(() => { api<Settings>('/admin/settings').then(setS) }, [])
  if (!s) return null
  const set = (patch: Partial<Settings>) => { setS({ ...s, ...patch }); setMsg('') }
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); act(() => api('/admin/settings', { method: 'PUT', body: s }), () => setMsg('Salvo')) }}>
      <div className="grid">
        <label>Plano do Claude<input value={s.plan_name} maxLength={60} placeholder="Ex.: Max 5x" onChange={(e) => set({ plan_name: e.target.value })} /></label>
        <label>Data de renovação do plano<input type="date" value={s.plan_renews_at} onChange={(e) => set({ plan_renews_at: e.target.value })} />
          <small className="muted">Não há fonte automática: informe a data da sua fatura.</small></label>
        <label>Duração máxima do vídeo (minutos)<input type="number" min={0.25} max={18} step={0.25} value={s.max_duration_s / 60} onChange={(e) => set({ max_duration_s: Math.round(Number(e.target.value) * 60) })} /></label>
        <label>Vídeos por dia por usuário (0 = sem limite)<input type="number" min={0} max={1000} value={s.daily_video_limit} onChange={(e) => set({ daily_video_limit: Number(e.target.value) })} /></label>
      </div>
      <div className="row"><span className="ok">{msg}</span><button>Salvar</button></div>
    </form>
  )
}

type AuditRow = { id: string; createdAt: string; actor: string; action: string; targetType: string; targetId: string | null; details: Record<string, unknown>; ip: string }

function Audit() {
  const [rows, setRows] = useState<AuditRow[]>([])
  useEffect(() => { api<AuditRow[]>('/admin/audit?limit=200').then(setRows) }, [])
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Alvo</th><th>Detalhes</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}>
          <td className="muted">{new Date(r.createdAt).toLocaleString('pt-BR')}</td>
          <td>{r.actor}</td><td><code>{r.action}</code></td><td>{r.targetType}{r.targetId ? ` · ${r.targetId.slice(0, 8)}` : ''}</td>
          <td className="details">{JSON.stringify(r.details)}</td>
        </tr>))}
      </tbody>
    </table></div>
  )
}
