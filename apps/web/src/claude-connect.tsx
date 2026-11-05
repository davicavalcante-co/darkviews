import { useEffect, useState } from 'react'
import { api } from './api'
import { Modal, Steps } from './ui'

type McpStatus = { desktop: boolean; code: boolean; restart?: boolean }

// Um botão conecta o Darkviews ao Claude (app e Claude Code). Nada de editar arquivo.
export function ClaudeLink({ compact }: { compact?: boolean }) {
  const [s, setS] = useState<McpStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [help, setHelp] = useState(false)
  const [justConnected, setJustConnected] = useState(false)
  useEffect(() => { api<McpStatus>('/admin/claude/mcp').then(setS).catch(() => {}) }, [])
  if (!s) return null
  const connected = s.desktop || s.code

  async function connect() {
    setBusy(true); setError('')
    try { setS(await api<McpStatus>('/admin/claude/mcp/connect', { method: 'POST' })); setJustConnected(true) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className={`claude-link${connected ? ' on' : ''}${compact ? ' compact' : ''}`}>
      <span className="claude-link-mark" aria-hidden="true">✳︎</span>
      <div className="claude-link-copy">
        <h3>{connected ? 'Darkviews conectado ao Claude' : 'Peça vídeos direto para o Claude'}</h3>
        <p className="muted">
          {justConnected && s.desktop
            ? 'Pronto! Feche e abra o app Claude uma vez. Depois é só pedir: "crie um vídeo de 2 minutos sobre…".'
            : connected
              ? `Funciona no ${[s.desktop && 'app Claude', s.code && 'Claude Code'].filter(Boolean).join(' e no ')}. Peça: "como está o meu último vídeo?"`
              : 'Converse com o Claude para criar, acompanhar e ajustar vídeos, sem abrir o site.'}
        </p>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <div className="claude-link-actions">
        <button type="button" className="link" onClick={() => setHelp(true)}>O que dá para pedir?</button>
        {!connected
          ? <button type="button" disabled={busy} onClick={connect}>{busy ? 'Conectando…' : 'Conectar ao Claude'}</button>
          : <button type="button" className="ghost-btn" disabled={busy} onClick={connect} title="Atualiza a conexão (use se trocou de usuário)">{busy ? 'Atualizando…' : 'Reconectar'}</button>}
      </div>

      <Modal open={help} onClose={() => setHelp(false)} kicker="Darkviews + Claude" title="O que dá para pedir ao Claude">
        <p className="muted">Depois de conectar, abra o app Claude e escreva como numa conversa. Exemplos:</p>
        <ul className="examples">
          <li>"Crie um vídeo de 2 minutos sobre o café especial da loja, com voz feminina animada."</li>
          <li>"Como está o meu último vídeo?"</li>
          <li>"Me mostra o roteiro do vídeo do café."</li>
          <li>"Deixe o título mais curto e regere."</li>
          <li>"Quanto ainda tenho de uso do Claude hoje?"</li>
        </ul>
        <Steps steps={[
          <>Clique em <b>Conectar ao Claude</b> (só uma vez).</>,
          <>Feche e abra o <b>app Claude</b>.</>,
          <>Na primeira vez, o Claude pergunta se pode usar o <b>Darkviews</b>: clique em <b>Permitir</b>.</>,
        ]} />
        <p className="muted small">O Claude age como você: vê e mexe só no que você pode ver e mexer no site.</p>
      </Modal>
    </div>
  )
}
