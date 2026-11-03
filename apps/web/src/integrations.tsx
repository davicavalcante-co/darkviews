import { useEffect, useState } from 'react'
import type { Tier } from '@corte/shared'
import { api } from './api'
import { ClaudeLink } from './claude-connect'
import { Modal, PageHead, Section, Steps } from './ui'

type Item = {
  provider: string; label: string; category: string; tier: Tier; help: string; signup: string | null; tutorial: string[]
  secrets: string[]; choices: Record<string, string[]>; builtIn: boolean
  configured: boolean; enabled: boolean; priority: number; config: Record<string, string>
  secretsSet: Record<string, string | null>; systemDefault: { enabled: boolean } | null
  lastTestAt: string | null; lastTestOk: boolean | null
}
type Scope = 'me' | 'system'

const CATEGORIES: [string, string, string][] = [
  ['voz', 'Voz', 'Quem narra o vídeo'],
  ['banco_de_imagens', 'Fotos e vídeos', 'De onde vêm as imagens reais das cenas'],
  ['música', 'Música', 'Trilha de fundo'],
]
const TIER: Record<Tier, [string, string]> = { gratis: ['Grátis', 'free'], gratis_chave: ['Grátis com cadastro', 'freekey'], pago: ['Pago', 'paid'] }
const FIELD_LABEL: Record<string, string> = { voice: 'Voz', voice_id: 'ID da voz', speed: 'Velocidade da fala', steps: 'Qualidade', api_key: 'Chave da API' }

// Pronta para usar: ligada e com a chave (se precisa de chave). Para o usuário, sem preferência própria vale o padrão do admin.
const ready = (i: Item, scope: Scope) => (scope === 'me' && !i.configured ? !!i.systemDefault?.enabled : i.enabled && i.secrets.every((n) => i.secretsSet[n]))
const isOn = (i: Item, scope: Scope) => (scope === 'me' && !i.configured ? !!i.systemDefault?.enabled : i.enabled)

export function Integrations({ scope }: { scope: Scope }) {
  const [items, setItems] = useState<Item[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const base = scope === 'system' ? '/admin/integrations' : '/integrations'
  const load = () => api<Item[]>(base).then(setItems)
  useEffect(() => { load() }, [scope])

  const put = (i: Item, body: Partial<{ enabled: boolean; priority: number; config: Record<string, string>; secrets: Record<string, string> }>) =>
    api(`${base}/${i.provider}`, { method: 'PUT', body: { enabled: isOn(i, scope), priority: i.priority, config: i.config, secrets: {}, ...body } })

  // "Usar como principal": a escolhida vai para o topo da categoria e as outras seguem na ordem em que estavam.
  async function makePrimary(i: Item) {
    const list = items.filter((x) => x.category === i.category).sort((a, b) => a.priority - b.priority)
    const next = [i, ...list.filter((x) => x.provider !== i.provider)]
    await Promise.all(next.map((x, k) => put(x, { priority: (k + 1) * 10, ...(x.provider === i.provider && { enabled: true }) })))
    await load()
  }

  const current = items.find((i) => i.provider === open)
  return (
    <div className="stack">
      <p className="muted lead">
        {scope === 'system'
          ? 'O padrão para todos os usuários. Quem configurar as próprias contas usa as dele; o resto segue este padrão.'
          : 'Já vem tudo pronto para usar. Se quiser, conecte suas próprias contas (grátis ou pagas) para vozes e imagens melhores.'}
      </p>
      {scope === 'me' && <ClaudeLinkSlot />}
      {CATEGORIES.map(([cat, title, hint], ci) => {
        const list = items.filter((i) => i.category === cat).sort((a, b) => a.priority - b.priority)
        const inUse = list.find((i) => ready(i, scope))
        return (
          <Section key={cat} idx={ci + 1} title={title} aside={hint}>
            <div className="in-use">
              <span className={`dot ${inUse ? 'on' : 'off'}`} />
              {inUse ? <>Em uso agora: <b>{inUse.label}</b></> : <>Nenhuma opção pronta. Ligue uma abaixo.</>}
            </div>
            <ul className="int-list">
              {list.map((i) => (
                <Row key={i.provider} item={i} scope={scope} inUse={i.provider === inUse?.provider}
                  onToggle={async (on) => { await put(i, { enabled: on }); load() }} onOpen={() => setOpen(i.provider)} />
              ))}
            </ul>
          </Section>
        )
      })}
      {current && (
        <Setup key={current.provider + current.lastTestAt + Object.values(current.secretsSet).join()} item={current} scope={scope} base={base}
          inUse={items.filter((x) => x.category === current.category && ready(x, scope)).sort((a, b) => a.priority - b.priority)[0]?.provider === current.provider}
          onClose={() => setOpen(null)} reload={load} makePrimary={() => makePrimary(current)} />
      )}
    </div>
  )
}

// O botão do Claude só aparece para o admin (é ele quem conecta o computador).
function ClaudeLinkSlot() {
  const [admin, setAdmin] = useState(false)
  useEffect(() => { api<{ user: { role: string } }>('/auth/me').then((r) => setAdmin(r.user.role === 'admin')).catch(() => {}) }, [])
  return admin ? <ClaudeLink compact /> : null
}

function Row({ item, scope, inUse, onToggle, onOpen }: { item: Item; scope: Scope; inUse: boolean; onToggle: (on: boolean) => void; onOpen: () => void }) {
  const on = isOn(item, scope)
  const needsKey = on && item.secrets.some((n) => !item.secretsSet[n]) && !(scope === 'me' && !item.configured)
  const [tierLabel, tierClass] = TIER[item.tier]
  return (
    <li className={`int-row${inUse ? ' in-use-row' : ''}`}>
      <span className="int-mark" aria-hidden="true">{item.label.slice(0, 2)}</span>
      <div className="int-main">
        <div className="int-name"><b>{item.label}</b><span className={`badge ${tierClass}`}>{tierLabel}</span>{inUse && <span className="badge st-on">Em uso</span>}{needsKey && <span className="badge st-warn">Falta a chave</span>}</div>
        <p className="muted">{item.help}</p>
      </div>
      <button type="button" className="ghost-btn" onClick={onOpen}>{item.secrets.length && !item.secrets.every((n) => item.secretsSet[n]) ? 'Conectar' : 'Configurar'}</button>
      <label className="switch" title={on ? 'Desligar' : 'Ligar'}>
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} aria-label={`${on ? 'Desligar' : 'Ligar'} ${item.label}`} />
        <span />
      </label>
    </li>
  )
}

// Popup de configuração: passo a passo, campos e ações no mesmo lugar.
function Setup({ item, scope, base, inUse, onClose, reload, makePrimary }: {
  item: Item; scope: Scope; base: string; inUse: boolean; onClose: () => void; reload: () => void; makePrimary: () => Promise<void>
}) {
  const [config, setConfig] = useState(item.config)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [editKey, setEditKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const on = isOn(item, scope)
  const [tierLabel, tierClass] = TIER[item.tier]
  const missingKey = item.secrets.some((n) => !item.secretsSet[n])

  async function act(fn: () => Promise<unknown>, okText?: string) {
    setBusy(true); setMsg(null)
    try { await fn(); if (okText) setMsg({ ok: true, text: okText }); reload() }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }
  const save = () => api(`${base}/${item.provider}`, { method: 'PUT', body: { enabled: on || Object.values(secrets).some(Boolean), priority: item.priority, config, secrets } })
  async function test() {
    setBusy(true); setMsg(null)
    try {
      await save(); setSecrets({})
      const r = await api<{ ok: boolean }>(`${base}/${item.provider}/test`, { method: 'POST' })
      setMsg(r.ok ? { ok: true, text: 'Funcionando! Já pode usar.' } : { ok: false, text: 'Não funcionou. Confira se a chave foi copiada inteira.' })
      reload()
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }

  return (
    <Modal open onClose={onClose} kicker={item.category === 'voz' ? 'Voz' : item.category === 'música' ? 'Música' : 'Fotos e vídeos'} title={item.label}>
      <div className="int-name"><span className={`badge ${tierClass}`}>{tierLabel}</span>{inUse && <span className="badge st-on">Em uso</span>}</div>
      <p className="muted">{item.help}</p>

      {(missingKey || item.secrets.length === 0) && item.tutorial.length > 0 && (
        <div className="howto">
          <h3>{item.secrets.length ? 'Como conectar' : 'Como funciona'}</h3>
          <Steps steps={item.tutorial} />
          {item.signup && missingKey && <a className="btn ghost" href={item.signup} target="_blank" rel="noopener noreferrer">Abrir o site para pegar a chave ↗</a>}
        </div>
      )}

      {(Object.keys(config).length > 0 || item.secrets.length > 0) && (
        <div className="setup-fields">
          {item.secrets.map((k) => (
            <label key={k}>{FIELD_LABEL[k] ?? k}
              {item.secretsSet[k] && !editKey
                ? <span className="key-set"><code>{item.secretsSet[k]}</code><button type="button" className="link" onClick={() => setEditKey(true)}>Trocar</button></span>
                : <input type="password" autoComplete="off" placeholder="Cole a chave aqui" value={secrets[k] ?? ''} onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value.trim() })} />}
            </label>
          ))}
          {Object.keys(config).map((k) => (
            <label key={k}>{FIELD_LABEL[k] ?? k}
              {item.choices[k]
                ? <select value={config[k]} onChange={(e) => setConfig({ ...config, [k]: e.target.value })}>{item.choices[k].map((c) => <option key={c}>{c}</option>)}</select>
                : k === 'speed'
                  ? <span className="range-row"><input type="range" min={0.85} max={1.3} step={0.01} value={Number(config[k]) || 1} onChange={(e) => setConfig({ ...config, [k]: e.target.value })} /><b>{Number(config[k] || 1).toFixed(2)}×</b></span>
                  : <input value={config[k]} onChange={(e) => setConfig({ ...config, [k]: e.target.value })} />}
            </label>
          ))}
        </div>
      )}

      {msg && <p className={msg.ok ? 'notice ok-box' : 'notice alert'} role="status">{msg.ok ? '✓' : '✕'} {msg.text}</p>}

      <footer className="modal-actions">
        {scope === 'me' && item.configured && <button type="button" className="link" disabled={busy} onClick={() => act(async () => { await api(`${base}/${item.provider}`, { method: 'DELETE' }); onClose() })}>Voltar ao padrão</button>}
        {!inUse && <button type="button" className="link" disabled={busy} onClick={() => act(makePrimary, 'Agora é a principal.')}>Usar como principal</button>}
        <span className="spacer" />
        <button type="button" className="ghost-btn" disabled={busy} onClick={test}>{busy ? 'Testando…' : 'Testar'}</button>
        <button type="button" disabled={busy} onClick={() => act(async () => { await save(); setSecrets({}) }, 'Salvo.')}>Salvar</button>
      </footer>
    </Modal>
  )
}

// Página "Integrações" de cada usuário (suas contas; o resto segue o padrão do admin).
export function MyIntegrations() {
  return (
    <div className="page">
      <PageHead kicker="Voz, fotos e música" title="Integrações" />
      <Integrations scope="me" />
    </div>
  )
}
