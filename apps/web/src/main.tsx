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

function App() {
  const hash = useHash()
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const accept = (s: Session | null) => { setCsrf(s?.csrfToken ?? ''); setSession(s) }
  useEffect(() => { api<Session>('/auth/me').then(accept, () => accept(null)) }, [])

  if (session === undefined) return null
  if (!session) return <Login onLogin={accept} />
  return (
    <div className="shell">
      <header>
        <strong><a href="#/">Corte Final</a></strong>
        <nav><a href="#/">Projetos</a><a href="#/novo">Novo vídeo</a>{session.user.role === 'admin' && <a href="#/admin">Admin</a>}</nav>
        <span>{session.user.name} · {session.user.role === 'admin' ? 'Admin' : 'Usuário'}</span>
        <button onClick={() => api('/auth/logout', { method: 'POST' }).finally(() => accept(null))}>Sair</button>
      </header>
      <main>
        {hash === '#/novo' ? <NewVideo />
          : hash.startsWith('#/aprovar/') ? <ApprovePage id={hash.slice('#/aprovar/'.length)} />
          : hash.startsWith('#/editar/') ? <EditPage id={hash.slice('#/editar/'.length)} />
          : hash.startsWith('#/projeto/') ? <Progress id={hash.slice('#/projeto/'.length)} />
          : hash === '#/admin' && session.user.role === 'admin' ? <AdminPage />
          : <><Dashboard isAdmin={session.user.role === 'admin'} /><ProjectList isAdmin={session.user.role === 'admin'} /></>}
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
