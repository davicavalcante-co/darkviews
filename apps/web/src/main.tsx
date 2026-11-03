import { StrictMode, useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type { PublicUser } from '@corte/shared'
import { DEMO_USERS } from '@corte/shared/src/demo'
import { api, setCsrf } from './api'
import { NewVideo, Progress, ProjectList } from './projects'
import { AdminPage } from './admin'
import { Dashboard } from './dashboard'
import { EditPage } from './edit'
import { ApprovePage } from './approve'
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

// Ícones simples (traço), herdam a cor do texto.
const ICONS: Record<string, string> = {
  painel: 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z',
  novo: 'M12 5v14M5 12h14',
  projetos: 'M3 7h18M3 12h18M3 17h18',
  edicao: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  aprovacao: 'M5 12l5 5L20 7',
  admin: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z',
  sair: 'M15 4h4v16h-4M10 17l5-5-5-5M15 12H3',
}
const Icon = ({ name }: { name: string }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name]} /></svg>
)

function Sidebar({ hash, user, onLogout }: { hash: string; user: PublicUser; onLogout: () => void }) {
  // Cada item fica ativo também nas telas que pertencem a ele (ex.: #/editar/:id está dentro de Edição).
  const items = [
    { href: '#/', label: 'Painel', icon: 'painel', match: (h: string) => h === '' || h === '#/' },
    { href: '#/novo', label: 'Novo vídeo', icon: 'novo', match: (h: string) => h === '#/novo' },
    { href: '#/projetos', label: 'Projetos', icon: 'projetos', match: (h: string) => h === '#/projetos' || h.startsWith('#/projeto/') },
    { href: '#/edicao', label: 'Edição', icon: 'edicao', match: (h: string) => h === '#/edicao' || h.startsWith('#/editar/') },
    { href: '#/aprovacao', label: 'Aprovação', icon: 'aprovacao', match: (h: string) => h === '#/aprovacao' || h.startsWith('#/aprovar/') },
    ...(user.role === 'admin' ? [{ href: '#/admin', label: 'Admin', icon: 'admin', match: (h: string) => h === '#/admin' }] : []),
  ]
  const initials = user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <a href="#/" className="logo"><span className="logo-mark">CF</span>Corte Final</a>
        <nav aria-label="Menu principal">
          {items.map((i) => (
            <a key={i.href} href={i.href} className={i.match(hash) ? 'active' : ''} aria-current={i.match(hash) ? 'page' : undefined}>
              <Icon name={i.icon} />{i.label}
            </a>
          ))}
        </nav>
      </div>
      <div className="user-card">
        <span className="avatar" aria-hidden="true">{initials}</span>
        <div className="who"><strong>{user.name}</strong><small>{user.role === 'admin' ? 'Admin' : 'Usuário'} · {user.email}</small></div>
        <button type="button" className="logout" onClick={onLogout} aria-label="Sair" title="Sair"><Icon name="sair" /><span>Sair</span></button>
      </div>
    </aside>
  )
}

function App() {
  const hash = useHash()
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const accept = (s: Session | null) => { setCsrf(s?.csrfToken ?? ''); setSession(s) }
  useEffect(() => { api<Session>('/auth/me').then(accept, () => accept(null)) }, [])

  if (session === undefined) return null
  if (!session) return <Login onLogin={accept} />
  const isAdmin = session.user.role === 'admin'
  return (
    <div className="shell">
      <Sidebar hash={hash} user={session.user} onLogout={() => api('/auth/logout', { method: 'POST' }).finally(() => accept(null))} />
      <main>
        {hash === '#/novo' ? <NewVideo />
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
