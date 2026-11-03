import { useEffect, useRef, useState } from 'react'
import { type Part } from '@corte/shared'
import { api, useFonts } from './api'

type Segment = { startS: number; endS: number; text: string; highlights: number[] }
type Track = { version: number; fontFamily: string; fontWeight: number; size: number; color: string; highlightColor: string; highlightMode: string; position: string; segments: Segment[] }
type ChangeReq = { id: string; part: Part; frameTimeS: number | null; type: string; text: string; status: string; author: string; appliedInVersion: number | null }
type Meta = { field: string; version: number; value: string; isCurrent: boolean; createdBy: string; createdAt: string }
type EditData = {
  status: string
  job: { type: string; status: string; stage: string | null; progress: number } | null
  scenes: { index: number; startS: number; endS: number; narration: string | null }[]
  videos: { version: number; durationS: number; isCurrent: boolean; createdAt: string }[]
  caption: Track | null
  captionVersions: { version: number; isCurrent: boolean; createdAt: string; fontFamily: string; segments: number }[]
  metadata: Meta[]
  changeRequests: ChangeReq[]
}

const TABS: [Part, string][] = [['video', 'Vídeo'], ['caption', 'Legenda'], ['title', 'Título'], ['description', 'Descrição'], ['keywords', 'Palavras-chave']]
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const when = (d: string) => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
const by = (c: string) => (c === 'claude' ? 'Claude' : c === 'system' ? 'sistema' : 'você')

async function act(fn: () => Promise<unknown>, reload: () => void) {
  try { await fn(); reload() } catch (e) { alert((e as Error).message) }
}

export function EditPage({ id }: { id: string }) {
  const [data, setData] = useState<EditData | null>(null)
  const [tab, setTab] = useState<Part>('video')
  const [missing, setMissing] = useState(false)
  const load = () => api<EditData>(`/projects/${id}/edit`).then(setData, () => setMissing(true))
  useEffect(() => { load() }, [id])
  // Enquanto há tarefa rodando, atualiza a cada 2 s para mostrar o andamento e a nova versão.
  useEffect(() => {
    if (!data?.job) return
    const t = setTimeout(load, 2000)
    return () => clearTimeout(t)
  }, [data])

  if (missing) return <p>Projeto não encontrado. <a href="#/">Voltar</a></p>
  if (!data) return null
  const busy = !!data.job
  const props = { id, data, reload: load, busy }
  return (
    <section>
      <p><a href={`#/projeto/${id}`}>← Andamento</a></p>
      <div className="row"><h2>Edição</h2><a className="btn" href={`#/aprovar/${id}`}>{data.status === 'approved' ? 'Ver cortes' : 'Aprovar'}</a></div>
      {data.job && <p className="warn" role="status">{data.job.status === 'paused' ? 'Pausado' : 'Em andamento'}: {data.job.stage ?? data.job.type} · {data.job.progress}%</p>}
      <div className="tabs" role="tablist">
        {TABS.map(([p, label]) => <button key={p} type="button" role="tab" aria-selected={tab === p} onClick={() => setTab(p)}>{label}</button>)}
      </div>
      {tab === 'video' && <VideoTab {...props} />}
      {tab === 'caption' && <CaptionTab {...props} />}
      {(tab === 'title' || tab === 'description' || tab === 'keywords') && <MetaTab key={tab} field={tab} {...props} />}
    </section>
  )
}

type TabProps = { id: string; data: EditData; reload: () => void; busy: boolean }

function Requests({ id, part, data, reload }: TabProps & { part: Part }) {
  const list = data.changeRequests.filter((c) => c.part === part)
  if (!list.length) return null
  return (
    <ul className="requests">{list.map((c) => (
      <li key={c.id} className={c.status}>
        {c.frameTimeS != null && <strong>{fmt(c.frameTimeS)} </strong>}{c.text}
        <small className="muted"> · {c.author} · {c.status === 'open' ? 'aberto' : `aplicado${c.appliedInVersion ? ` na v${c.appliedInVersion}` : ''}`}</small>
        {c.status === 'open' && <button className="link" onClick={() => act(() => api(`/projects/${id}/change-requests/${c.id}`, { method: 'DELETE' }), reload)}>remover</button>}
      </li>))}
    </ul>
  )
}

// Regerar uma parte: o pedido opcional vira um pedido de alteração, e o Claude aplica todos os abertos.
function Regen({ id, part, reload, busy, label }: TabProps & { part: Part; label: string }) {
  const [text, setText] = useState('')
  async function go() {
    if (text.trim()) await api(`/projects/${id}/change-requests`, { method: 'POST', body: { part, text } })
    await api(`/projects/${id}/regen`, { method: 'POST', body: { part } })
    setText('')
  }
  return (
    <div className="regen">
      <input placeholder="O que mudar? (opcional) Ex.: mais curto, mais emoção" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
      <button type="button" disabled={busy} onClick={() => act(go, reload)}>{label}</button>
    </div>
  )
}

function VideoTab(props: TabProps) {
  const { id, data, reload, busy } = props
  const ref = useRef<HTMLVideoElement>(null)
  const [time, setTime] = useState(0)
  const [text, setText] = useState('')
  const [type, setType] = useState('trocar_imagem')
  const current = data.videos.find((v) => v.isCurrent)
  if (!current) return <p className="muted">O vídeo ainda não foi criado.</p>
  const thumbs = Array.from({ length: 12 }, (_, i) => (current.durationS * (i + 0.5)) / 12)
  const seek = (t: number) => { if (ref.current) ref.current.currentTime = t }
  const scene = data.scenes.find((s) => time >= s.startS && time < s.endS)

  return (
    <div className="stack">
      <video ref={ref} className="player" controls preload="metadata" src={`/api/projects/${id}/video?v=${current.version}`} onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} />
      <div className="timeline" aria-label="Linha do tempo">
        {thumbs.map((t) => (
          <button key={t} type="button" onClick={() => seek(t)} aria-label={`Ir para ${fmt(t)}`}>
            <img src={`/api/projects/${id}/frame?t=${t.toFixed(1)}&v=${current.version}`} alt="" loading="lazy" />
          </button>
        ))}
        <span className="cursor" style={{ left: `${(time / current.durationS) * 100}%` }} />
        {data.changeRequests.filter((c) => c.part === 'video' && c.frameTimeS != null).map((c) => (
          <span key={c.id} className={`marker ${c.status}`} style={{ left: `${(c.frameTimeS! / current.durationS) * 100}%` }} title={c.text} onClick={() => seek(c.frameTimeS!)} />
        ))}
      </div>
      <p className="muted">Quadro em {fmt(time)}{scene ? ` · cena ${scene.index + 1}: ${scene.narration ?? ''}` : ''}</p>

      <fieldset>
        <legend>Pedir alteração neste quadro ({fmt(time)})</legend>
        <div className="regen">
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Tipo">
            <option value="trocar_imagem">Trocar imagem</option><option value="mudar_texto">Mudar fala/texto</option>
            <option value="mudar_ritmo">Mudar ritmo</option><option value="outro">Outro</option>
          </select>
          <input placeholder="Ex.: troque por uma foto do produto" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
          <button type="button" disabled={!text.trim()} onClick={() => act(async () => {
            await api(`/projects/${id}/change-requests`, { method: 'POST', body: { part: 'video', frameTimeS: Math.round(time * 10) / 10, type, text } })
            setText('')
          }, reload)}>Marcar</button>
        </div>
        <Requests {...props} part="video" />
        <button type="button" disabled={busy || !data.changeRequests.some((c) => c.part === 'video' && c.status === 'open')}
          onClick={() => act(() => api(`/projects/${id}/regen`, { method: 'POST', body: { part: 'video' } }), reload)}>
          Regerar vídeo com os pedidos
        </button>
      </fieldset>

      <History items={data.videos.map((v) => ({ version: v.version, isCurrent: v.isCurrent, label: `${fmt(v.durationS)} · ${when(v.createdAt)}` }))}
        onRestore={(version) => act(() => api(`/projects/${id}/video/restore`, { method: 'POST', body: { version } }), reload)} />
    </div>
  )
}

function useGoogleFont(family: string, weight: number) {
  useEffect(() => {
    const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&display=swap`
    if (document.querySelector(`link[href="${href}"]`)) return
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l)
  }, [family, weight])
}

function CaptionTab(props: TabProps) {
  const allowed = useFonts()
  const { id, data, reload, busy } = props
  const [track, setTrack] = useState<Track | null>(data.caption)
  useEffect(() => setTrack(data.caption), [data.caption?.version])
  useGoogleFont(track?.fontFamily ?? 'Inter', track?.fontWeight ?? 700)
  if (!track) return <p className="muted">A legenda é criada junto com o vídeo.</p>

  const set = (patch: Partial<Track>) => setTrack({ ...track, ...patch })
  const setSeg = (i: number, patch: Partial<Segment>) => set({ segments: track.segments.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const toggle = (i: number, w: number) => {
    const h = track.segments[i].highlights
    setSeg(i, { highlights: h.includes(w) ? h.filter((x) => x !== w) : [...h, w] })
  }
  const { version: _v, ...body } = track
  const save = () => api(`/projects/${id}/captions`, { method: 'PUT', body })

  return (
    <div className="stack">
      <div className="grid">
        <label>Fonte<select value={track.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })}>{[...new Set([track.fontFamily, ...allowed])].map((f) => <option key={f}>{f}</option>)}</select></label>
        <label>Peso<select value={track.fontWeight} onChange={(e) => set({ fontWeight: Number(e.target.value) })}><option value={400}>Normal</option><option value={700}>Negrito</option><option value={900}>Extra</option></select></label>
        <label>Tamanho<input type="number" min={24} max={140} value={track.size} onChange={(e) => set({ size: Number(e.target.value) })} /></label>
        <label>Posição<select value={track.position} onChange={(e) => set({ position: e.target.value })}><option value="bottom">Embaixo</option><option value="middle">Centro</option></select></label>
        <label>Cor<input type="color" value={track.color} onChange={(e) => set({ color: e.target.value.toUpperCase() })} /></label>
        <label>Cor do destaque<input type="color" value={track.highlightColor} onChange={(e) => set({ highlightColor: e.target.value.toUpperCase() })} /></label>
        <label>Destaque<select value={track.highlightMode} onChange={(e) => set({ highlightMode: e.target.value })}>
          <option value="palavra-chave">Palavras-chave</option><option value="karaokê">Karaokê</option><option value="manual">Manual</option>
        </select></label>
      </div>
      <p className="muted">Clique numa palavra para ligar ou desligar o destaque.</p>
      <div className="segments">
        {track.segments.map((s, i) => (
          <div className="segment" key={i}>
            <input type="number" step={0.1} min={0} value={s.startS} aria-label="Início (s)" onChange={(e) => setSeg(i, { startS: Number(e.target.value) })} />
            <input type="number" step={0.1} min={0} value={s.endS} aria-label="Fim (s)" onChange={(e) => setSeg(i, { endS: Number(e.target.value) })} />
            <div>
              <input value={s.text} maxLength={200} aria-label="Texto" onChange={(e) => setSeg(i, { text: e.target.value, highlights: s.highlights.filter((h) => h < e.target.value.split(/\s+/).length) })} />
              <div className="words" style={{ fontFamily: track.fontFamily, fontWeight: track.fontWeight }}>
                {s.text.split(/\s+/).filter(Boolean).map((w, j) => (
                  <button type="button" key={j} onClick={() => toggle(i, j)} style={{ color: s.highlights.includes(j) || track.highlightMode === 'karaokê' ? track.highlightColor : track.color }}>{w}</button>
                ))}
              </div>
            </div>
            <button type="button" className="link" aria-label="Remover linha" onClick={() => set({ segments: track.segments.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
      </div>
      <div className="row">
        <button type="button" className="link" onClick={() => {
          const last = track.segments.at(-1)
          set({ segments: [...track.segments, { startS: last?.endS ?? 0, endS: (last?.endS ?? 0) + 2, text: 'Nova legenda', highlights: [] }] })
        }}>+ Linha</button>
        <span>
          <button type="button" className="link" onClick={() => act(save, reload)}>Salvar versão</button>{' '}
          <button type="button" disabled={busy} onClick={() => act(async () => { await save(); await api(`/projects/${id}/render`, { method: 'POST' }) }, reload)}>Salvar e renderizar</button>
        </span>
      </div>
      <Requests {...props} part="caption" />
      <Regen {...props} part="caption" label="Regerar legenda com Claude" />
      <History items={data.captionVersions.map((v) => ({ version: v.version, isCurrent: v.isCurrent, label: `${v.fontFamily} · ${v.segments} linhas · ${when(v.createdAt)}` }))}
        onRestore={(version) => act(() => api(`/projects/${id}/captions/restore`, { method: 'POST', body: { version } }), reload)} />
    </div>
  )
}

function MetaTab(props: TabProps & { field: 'title' | 'description' | 'keywords' }) {
  const { id, data, reload, field } = props
  const versions = data.metadata.filter((m) => m.field === field)
  const current = versions.find((m) => m.isCurrent)
  const [value, setValue] = useState(current?.value ?? '')
  useEffect(() => setValue(current?.value ?? ''), [current?.version])
  const label = { title: 'Título', description: 'Descrição', keywords: 'Palavras-chave (separadas por vírgula)' }[field]
  return (
    <div className="stack">
      <label>{label}
        {field === 'title'
          ? <input value={value} maxLength={100} onChange={(e) => setValue(e.target.value)} />
          : <textarea rows={field === 'description' ? 10 : 3} value={value} maxLength={5000} onChange={(e) => setValue(e.target.value)} />}
        {field === 'title' && <small className="muted">{value.length}/100</small>}
      </label>
      <div className="row"><span /><button type="button" disabled={value === current?.value}
        onClick={() => act(() => api(`/projects/${id}/metadata/${field}`, { method: 'PUT', body: { value } }), reload)}>Salvar versão</button></div>
      <Requests {...props} part={field} />
      <Regen {...props} part={field} label="Regerar com Claude" />
      <History items={versions.map((v) => ({ version: v.version, isCurrent: v.isCurrent, label: `${by(v.createdBy)} · ${when(v.createdAt)}`, preview: v.value }))}
        onRestore={(version) => act(() => api(`/projects/${id}/metadata/${field}/restore`, { method: 'POST', body: { version } }), reload)} />
    </div>
  )
}

function History({ items, onRestore }: { items: { version: number; isCurrent: boolean; label: string; preview?: string }[]; onRestore: (v: number) => void }) {
  if (!items.length) return null
  return (
    <details>
      <summary>Histórico de versões ({items.length})</summary>
      <ul className="history">{items.map((v) => (
        <li key={v.version}>
          <strong>v{v.version}</strong> {v.label} {v.isCurrent ? <em>· atual</em> : <button className="link" onClick={() => onRestore(v.version)}>voltar para esta</button>}
          {v.preview && <p className="pre muted">{v.preview.slice(0, 300)}</p>}
        </li>))}
      </ul>
    </details>
  )
}
