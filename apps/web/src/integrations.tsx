import { useEffect, useState } from 'react'
import { api } from './api'

type Item = {
  provider: string; label: string; category: string; help: string; secrets: string[]
  enabled: boolean; priority: number; config: Record<string, string>
  secretsSet: Record<string, string | null>; lastTestAt: string | null; lastTestOk: boolean | null
}

function Row({ item, reload }: { item: Item; reload: () => void }) {
  const [enabled, setEnabled] = useState(item.enabled)
  const [priority, setPriority] = useState(item.priority)
  const [config, setConfig] = useState(item.config)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState('')

  async function save() {
    setMsg('')
    try {
      await api(`/admin/integrations/${item.provider}`, { method: 'PUT', body: { enabled, priority, config, secrets } })
      setSecrets({}); setMsg('Salvo'); reload()
    } catch (e) { setMsg((e as Error).message) }
  }
  async function test() {
    setMsg('Testando…')
    try { const r = await api<{ ok: boolean }>(`/admin/integrations/${item.provider}/test`, { method: 'POST' }); setMsg(r.ok ? 'Funcionando' : 'Falhou'); reload() }
    catch (e) { setMsg((e as Error).message) }
  }

  return (
    <fieldset>
      <legend>{item.label} · {item.category}</legend>
      <p className="muted">{item.help}</p>
      <div className="grid">
        <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Ligada</label>
        <label>Prioridade (menor = primeiro)<input type="number" min={0} max={100} value={priority} onChange={(e) => setPriority(Number(e.target.value))} /></label>
        {Object.keys(config).map((k) => (
          <label key={k}>{k}<input value={config[k]} onChange={(e) => setConfig({ ...config, [k]: e.target.value })} /></label>
        ))}
        {item.secrets.map((k) => (
          <label key={k}>{k} {item.secretsSet[k] && <small className="muted">atual: {item.secretsSet[k]}</small>}
            <input type="password" autoComplete="off" placeholder={item.secretsSet[k] ? 'deixe vazio para manter' : 'cole a chave'}
              value={secrets[k] ?? ''} onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })} />
          </label>
        ))}
      </div>
      <div className="row">
        <span className="muted">{item.lastTestAt ? `Último teste: ${item.lastTestOk ? 'ok' : 'falhou'} em ${new Date(item.lastTestAt).toLocaleString('pt-BR')}` : ''} {msg && <strong>{msg}</strong>}</span>
        <span><button type="button" className="link" onClick={test}>Testar</button> <button type="button" onClick={save}>Salvar</button></span>
      </div>
    </fieldset>
  )
}

export function Integrations() {
  const [items, setItems] = useState<Item[]>([])
  const load = () => api<Item[]>('/admin/integrations').then(setItems)
  useEffect(() => { load() }, [])
  return (
    <section>
      <h2>Integrações</h2>
      <p className="muted">As chaves ficam criptografadas no servidor e nunca voltam para o navegador. Se a primeira de uma categoria falhar, o sistema tenta a próxima.</p>
      {items.map((i) => <Row key={i.provider + i.lastTestAt + Object.values(i.secretsSet).join()} item={i} reload={load} />)}
    </section>
  )
}
