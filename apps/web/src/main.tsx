import { StrictMode, useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type { PublicUser } from '@corte/shared'
import { DEMO_USERS } from '@corte/shared/src/demo'
import { api, setCsrf } from './api'
import { Progress, ProjectList } from './projects'
import { NewVideo } from './studio'
import { AdminPage } from './admin'
import { Dashboard } from './dashboard'
import { ClaudePill } from './claude-pill'
import { Icon } from './icons'
import { MyIntegrations } from './integrations'
import { EditPage } from './edit'
import { ApprovePage } from './approve'
import { VoicesPage } from './voices'
import './style.css'

type Session = { user: PublicUser; csrfToken: string }

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'setup'>('login')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = Object.fromEntries(new FormData(e.currentTarget))
    setBusy(true); setError('')
    try {
      onLogin(await api<Session>(mode === 'login' ? '/auth/login' : '/auth/setup', { method: 'POST', body: f }))
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  async function quick(email: string, password: string) {
    setBusy(true); setError('')
    try { onLogin(await api<Session>('/auth/login', { method: 'POST', body: { email, password } })) }
    catch (err) { setError((err as Error).message + ' — rode: pnpm run db:demo') } finally { setBusy(false) }
  }

  return (
    <main className="login">
      <form onSubmit={submit} className="card">
        <h1>Corte Final</h1>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => setMode('login')}>Entrar</button>
          <button type="button" role="tab" aria-selected={mode === 'setup'} onClick={() => setMode('setup')}>Primeiro acesso</button>
        </div>
        {mode === 'login' ? (
          <label>E-mail<input name="email" type="email" autoComplete="username" required /></label>
        ) : (
          <label>Token de primeiro acesso<input name="token" required autoComplete="off" /></label>
        )}
        <label>{mode === 'login' ? 'Senha' : 'Nova senha (mín. 10 caracteres)'}
          <input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={mode === 'setup' ? 10 : 1} required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={busy}>{busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Definir senha e entrar'}</button>
        {import.meta.env.DEV && (
          <div className="demo">
            <p>Acesso rápido de teste (só em desenvolvimento)</p>
            {DEMO_USERS.map((u) => (
              <button type="button" key={u.email} disabled={busy} onClick={() => quick(u.email, u.password)}>
                {u.role === 'admin' ? 'Entrar como Admin' : 'Entrar como Usuário'}
              </button>
            ))}
          </div>
        )}
      </form>
    </main>
  )
}

function useHash() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => { const f = () => setHash(location.hash); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  return hash
}

// Recolhida no primeiro acesso; a escolha fica salva neste navegador.
function useSidebarExpanded(): [boolean, (v: boolean) => void] {
  const [expanded, set] = useState(() => { try { return localStorage.getItem('sidebar-expanded') === '1' } catch { return false } })
  return [expanded, (v) => { set(v); try { localStorage.setItem('sidebar-expanded', v ? '1' : '0') } catch { /* sem armazenamento: vale só nesta visita */ } }]
}

function Sidebar({ hash, user, onLogout, expanded, onToggle }: { hash: string; user: PublicUser; onLogout: () => void; expanded: boolean; onToggle: () => void }) {
  // Cada item fica ativo também nas telas que pertencem a ele (ex.: #/editar/:id está dentro de Edição).
  const items = [
    { href: '#/', label: 'Painel', icon: 'painel', match: (h: string) => h === '' || h === '#/' },
    { href: '#/novo', label: 'Novo vídeo', icon: 'novo', match: (h: string) => h === '#/novo' },
    { href: '#/projetos', label: 'Projetos', icon: 'projetos', match: (h: string) => h === '#/projetos' || h.startsWith('#/projeto/') },
    { href: '#/edicao', label: 'Edição', icon: 'edicao', match: (h: string) => h === '#/edicao' || h.startsWith('#/editar/') },
    { href: '#/aprovacao', label: 'Aprovação', icon: 'aprovacao', match: (h: string) => h === '#/aprovacao' || h.startsWith('#/aprovar/') },
    { href: '#/vozes', label: 'Vozes', icon: 'vozes', match: (h: string) => h === '#/vozes' },
    { href: '#/integracoes', label: 'Integrações', icon: 'integracoes', match: (h: string) => h === '#/integracoes' },
    ...(user.role === 'admin' ? [{ href: '#/admin', label: 'Admin', icon: 'admin', match: (h: string) => h === '#/admin' }] : []),
  ]
  const initials = user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  return (
    <aside className="sidebar" data-expanded={expanded}>
      <div className="sidebar-top">
        <div className="brand">
          <a href="#/" className="logo" aria-label="Corte Final, ir para o Painel"><span className="logo-mark">CF</span><span className="nav-text">Corte Final</span></a>
          <button type="button" className="toggle" onClick={onToggle} aria-expanded={expanded} aria-label={expanded ? 'Recolher menu' : 'Expandir menu'} title={expanded ? 'Recolher menu' : 'Expandir menu'}>
            <Icon name={expanded ? 'recolher' : 'expandir'} />
          </button>
        </div>
        <nav aria-label="Menu principal">
          {items.map((i) => (
            <a key={i.href} href={i.href} className={i.match(hash) ? 'active' : ''} aria-current={i.match(hash) ? 'page' : undefined} data-tip={i.label} aria-label={expanded ? undefined : i.label}>
              <Icon name={i.icon} /><span className="nav-text">{i.label}</span>
            </a>
          ))}
        </nav>
      </div>
      <div className="user-card">
        <span className="avatar" aria-hidden="true" title={`${user.name} · ${user.email}`}>{initials}</span>
        <div className="who nav-text"><strong>{user.name}</strong><small>{user.role === 'admin' ? 'Admin' : 'Usuário'} · {user.email}</small></div>
        <button type="button" className="logout" onClick={onLogout} aria-label="Sair" data-tip="Sair"><Icon name="sair" /></button>
      </div>
    </aside>
  )
}

function App() {
  const hash = useHash()
  const [expanded, setExpanded] = useSidebarExpanded()
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const accept = (s: Session | null) => { setCsrf(s?.csrfToken ?? ''); setSession(s) }
  useEffect(() => { api<Session>('/auth/me').then(accept, () => accept(null)) }, [])

  if (session === undefined) return null
  if (!session) return <Login onLogin={accept} />
  const isAdmin = session.user.role === 'admin'
  return (
    <div className={`shell${expanded ? '' : ' collapsed'}`}>
      <Sidebar hash={hash} user={session.user} expanded={expanded} onToggle={() => setExpanded(!expanded)}
        onLogout={() => api('/auth/logout', { method: 'POST' }).finally(() => accept(null))} />
      <main>
        <ClaudePill isAdmin={isAdmin} />
        {hash === '#/novo' ? <NewVideo />
          : hash === '#/integracoes' ? <MyIntegrations />
          : hash === '#/vozes' ? <VoicesPage />
          : hash === '#/projetos' ? <ProjectList isAdmin={isAdmin} />
          : hash === '#/edicao' ? <ProjectList isAdmin={isAdmin} title="Edição" statuses={['editing', 'in_approval', 'failed']} href={(id) => `#/editar/${id}`} empty="Nenhum vídeo pronto para editar. Os vídeos aparecem aqui quando terminam de ser criados." />
          : hash === '#/aprovacao' ? <ProjectList isAdmin={isAdmin} title="Aprovação" statuses={['in_approval', 'editing', 'approved']} href={(id) => `#/aprovar/${id}`} empty="Nenhum vídeo para aprovar ainda." />
          : hash.startsWith('#/aprovar/') ? <ApprovePage id={hash.slice('#/aprovar/'.length)} />
          : hash.startsWith('#/editar/') ? <EditPage id={hash.slice('#/editar/'.length)} />
          : hash.startsWith('#/projeto/') ? <Progress id={hash.slice('#/projeto/'.length)} />
          : hash === '#/admin' && isAdmin ? <AdminPage />
          : <Dashboard isAdmin={isAdmin} />}
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
