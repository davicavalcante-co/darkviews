import { StrictMode, useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import type { PublicUser } from '@corte/shared'
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

// Primeiro acesso: entrou pelo token, agora define e-mail, nome e senha. Não fecha até concluir.
function CompleteSetup({ onDone }: { onDone: (u: PublicUser) => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
    if (f.password !== f.confirm) return setError('As senhas não são iguais')
    setBusy(true); setError('')
    try { onDone((await api<{ user: PublicUser }>('/auth/complete-setup', { method: 'POST', body: { name: f.name, email: f.email, password: f.password } })).user) }
    catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="setup-overlay" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <form onSubmit={submit} className="card setup-card">
        <span className="kicker">Bem-vindo ao Darkviews</span>
        <h1 id="setup-title">Crie o seu acesso</h1>
        <p className="muted">Defina o e-mail e a senha que você vai usar para entrar daqui para frente.</p>
        <label>Seu nome<input name="name" required maxLength={120} autoComplete="name" /></label>
        <label>E-mail<input name="email" type="email" required autoComplete="username" /></label>
        <label>Nova senha (mín. 10 caracteres)<input name="password" type="password" minLength={10} required autoComplete="new-password" /></label>
        <label>Repita a senha<input name="confirm" type="password" minLength={10} required autoComplete="new-password" /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={busy}>{busy ? 'Salvando…' : 'Salvar e continuar'}</button>
      </form>
    </div>
  )
}

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

  return (
    <main className="login">
      <form onSubmit={submit} className="card">
        <h1>Darkviews</h1>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => setMode('login')}>Entrar</button>
          <button type="button" role="tab" aria-selected={mode === 'setup'} onClick={() => setMode('setup')}>Primeiro acesso</button>
        </div>
        {mode === 'login' ? (
          <>
            <label>E-mail<input name="email" type="email" autoComplete="username" required /></label>
            <label>Senha<input name="password" type="password" autoComplete="current-password" required /></label>
          </>
        ) : (
          <label>Token de primeiro acesso<input name="token" required autoComplete="off" placeholder="Cole aqui o token que o instalador mostrou" /></label>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={busy}>{busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Entrar com o token'}</button>
      </form>
    </main>
  )
}

// Tema: escuro é o padrão; a escolha fica salva neste navegador.
const readTheme = () => { try { return localStorage.getItem('theme') === 'light' ? 'light' : 'dark' } catch { return 'dark' } }
document.documentElement.dataset.theme = readTheme()
function ThemeToggle() {
  const [theme, setTheme] = useState(readTheme)
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('theme', theme) } catch { /* sem armazenamento: vale só nesta visita */ } }, [theme])
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button type="button" className="theme-btn" onClick={() => setTheme(next)} aria-label={next === 'light' ? 'Mudar para o tema claro' : 'Mudar para o tema escuro'} title={next === 'light' ? 'Tema claro' : 'Tema escuro'}>
      <Icon name={theme === 'dark' ? 'sol' : 'lua'} size={18} />
    </button>
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
    { href: '#/projetos', label: 'Projetos', icon: 'projetos', match: (h: string) => h === '#/projetos' || h.startsWith('#/projeto/') || h.startsWith('#/editar/') },
    { href: '#/aprovados', label: 'Aprovados', icon: 'aprovacao', match: (h: string) => h === '#/aprovados' || h.startsWith('#/aprovar/') },
    { href: '#/vozes', label: 'Vozes', icon: 'vozes', match: (h: string) => h === '#/vozes' },
    { href: '#/integracoes', label: 'Integrações', icon: 'integracoes', match: (h: string) => h === '#/integracoes' },
    ...(user.role === 'admin' ? [{ href: '#/admin', label: 'Admin', icon: 'admin', match: (h: string) => h === '#/admin' }] : []),
  ]
  const initials = user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  return (
    <aside className="sidebar" data-expanded={expanded}>
      <div className="sidebar-top">
        <div className="brand">
          <a href="#/" className="logo" aria-label="Darkviews, ir para o Painel"><span className="logo-mark">DV</span><span className="nav-text">Darkviews</span></a>
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
  useEffect(() => {
    const f = (e: Event) => setSession((cur) => cur && { ...cur, user: (e as CustomEvent<PublicUser>).detail })
    addEventListener('profile-changed', f); return () => removeEventListener('profile-changed', f)
  }, [])

  if (session === undefined) return null
  if (!session) return <Login onLogin={accept} />
  const isAdmin = session.user.role === 'admin'
  return (
    <div className={`shell${expanded ? '' : ' collapsed'}`}>
      <Sidebar hash={hash} user={session.user} expanded={expanded} onToggle={() => setExpanded(!expanded)}
        onLogout={() => api('/auth/logout', { method: 'POST' }).finally(() => accept(null))} />
      <main>
        <div className="top-bar"><ThemeToggle /><ClaudePill isAdmin={isAdmin} /></div>
        {hash === '#/novo' ? <NewVideo />
          : hash === '#/integracoes' ? <MyIntegrations isAdmin={isAdmin} />
          : hash === '#/vozes' ? <VoicesPage />
          : hash === '#/projetos' ? <ProjectList isAdmin={isAdmin} />
          : hash === '#/aprovados' ? <ProjectList isAdmin={isAdmin} title="Aprovados" statuses={['approved']} href={(id) => `#/aprovar/${id}`} empty="Nenhum vídeo aprovado ainda. A aprovação é feita dentro do projeto, no botão Aprovar." />
          : hash.startsWith('#/aprovar/') ? <ApprovePage id={hash.slice('#/aprovar/'.length)} />
          : hash.startsWith('#/editar/') ? <EditPage id={hash.slice('#/editar/'.length)} />
          : hash.startsWith('#/projeto/') ? <Progress id={hash.slice('#/projeto/'.length)} />
          : hash === '#/admin' && isAdmin ? <AdminPage />
          : <Dashboard isAdmin={isAdmin} />}
      </main>
      {/* Pop-up por cima do sistema até a pessoa definir e-mail e senha. */}
      {session.user.needsSetup && <CompleteSetup onDone={(user) => setSession({ ...session, user })} />}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
