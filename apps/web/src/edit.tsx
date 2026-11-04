import { useEffect, useRef, useState } from 'react'
import { type Part } from '@corte/shared'
import { api, useFonts } from './api'
import { CaptionPosition, FontSelect, Modal, PageHead } from './ui'
import { ThumbnailTab } from './thumbnail'

type Segment = { startS: number; endS: number; text: string; highlights: number[] }
type Track = { version: number; fontFamily: string; fontWeight: number; size: number; color: string; highlightColor: string; highlightMode: string; position: string; outline?: boolean; segments: Segment[] }
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

type Tab = Part | 'thumbnail'
const TABS: [Tab, string][] = [['video', 'Vídeo'], ['caption', 'Legenda'], ['title', 'Título'], ['description', 'Descrição'], ['keywords', 'Palavras-chave'], ['thumbnail', 'Thumbnail']]
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const when = (d: string) => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
const by = (c: string) => (c === 'claude' ? 'Claude' : c === 'system' ? 'sistema' : 'você')

async function act(fn: () => Promise<unknown>, reload: () => void) {
  try { await fn(); reload() } catch (e) { alert((e as Error).message) }
}

export function EditPage({ id }: { id: string }) {
  const [data, setData] = useState<EditData | null>(null)
  const [tab, setTab] = useState<Tab>('video')
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
    <div className="page">
      <PageHead back={{ href: `#/projeto/${id}`, label: 'Andamento' }} kicker="Cada parte tem histórico e pode ser regerada sozinha" title="Edição">
        <a className="btn" href={`#/aprovar/${id}`}>{data.status === 'approved' ? 'Ver cortes' : 'Aprovar'}</a>
      </PageHead>
      {data.job && <p className="warn" role="status">{data.job.status === 'paused' ? 'Pausado' : 'Em andamento'}: {data.job.stage ?? data.job.type} · {data.job.progress}%</p>}
      <div className="stack">
        <div className="tabs" role="tablist">
          {TABS.map(([p, label]) => <button key={p} type="button" role="tab" aria-selected={tab === p} onClick={() => setTab(p)}>{label}</button>)}
        </div>
        {tab === 'video' && <VideoTab {...props} />}
        {tab === 'caption' && <CaptionTab {...props} />}
        {(tab === 'title' || tab === 'description' || tab === 'keywords') && <MetaTab key={tab} field={tab} {...props} />}
        {tab === 'thumbnail' && <ThumbnailTab id={id} video={data.videos.find((v) => v.isCurrent) ?? null}
          title={data.metadata.find((m) => m.field === 'title' && m.isCurrent)?.value ?? ''} />}
      </div>
    </div>
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
    <div className="cards">
      <div className="panel wide">
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
      </div>

      <fieldset>
        <legend>Pedir alteração no quadro {fmt(time)}</legend>
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
  const ref = useRef<HTMLVideoElement>(null)
  const [track, setTrack] = useState<Track | null>(data.caption)
  const [time, setTime] = useState(0)
  const [styleOpen, setStyleOpen] = useState(false)
  const [saved, setSaved] = useState('')
  useEffect(() => setTrack(data.caption), [data.caption?.version])
  useGoogleFont(track?.fontFamily ?? 'Inter', track?.fontWeight ?? 700)
  const video = data.videos.find((v) => v.isCurrent)
  if (!track || !video) return <p className="muted">A legenda aparece aqui quando o vídeo terminar de ser criado.</p>

  const set = (patch: Partial<Track>) => { setTrack({ ...track, ...patch }); setSaved('') }
  const segs = track.segments
  const setSeg = (i: number, patch: Partial<Segment>) => set({ segments: segs.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const toggle = (i: number, w: number) => {
    const h = segs[i].highlights
    setSeg(i, { highlights: h.includes(w) ? h.filter((x) => x !== w) : [...h, w] })
  }
  const seek = (t: number) => { if (ref.current) { ref.current.currentTime = t; setTime(t) } }
  const active = segs.findIndex((s) => time >= s.startS && time < s.endS)
  // Sem legenda neste instante: a mais próxima depois (para os botões de anterior/próxima).
  const nextIdx = segs.findIndex((s) => s.startS > time)
  const cur = active >= 0 ? segs[active] : null
  const { version: _v, ...body } = track
  const save = () => api(`/projects/${id}/captions`, { method: 'PUT', body })
  const nudge = (i: number, key: 'startS' | 'endS', d: number) => setSeg(i, { [key]: Math.max(0, Math.round((segs[i][key] + d) * 10) / 10) })
  const color = (w: number, s: Segment) => (s.highlights.includes(w) || track.highlightMode === 'karaokê' ? track.highlightColor : track.color)

  return (
    <div className="cards">
      <div className="panel wide">
        <div className="caption-stage">
          <video ref={ref} className="player" controls preload="metadata" src={`/api/projects/${id}/video?v=${video.version}`}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} />
          {/* Prévia: a legenda deste instante com a fonte e as cores escolhidas. */}
          {cur && (
            <div className={`caption-preview ${track.position.replace("-", " ")}${track.outline === false ? " no-outline" : ""}`} style={{ fontFamily: track.fontFamily, fontWeight: track.fontWeight, fontSize: `clamp(14px, ${track.size / 24}vw, ${track.size / 2.2}px)` }}>
              {cur.text.split(/\s+/).filter(Boolean).map((w, j) => <span key={j} style={{ color: color(j, cur) }}>{w} </span>)}
            </div>
          )}
        </div>
        <div className="seg-track" aria-label="Legendas ao longo do vídeo">
          {segs.map((s, i) => (
            <button key={i} type="button" className={`seg-block${i === active ? ' on' : ''}`} title={s.text}
              style={{ left: `${(s.startS / video.durationS) * 100}%`, width: `${Math.max(0.4, ((s.endS - s.startS) / video.durationS) * 100)}%` }}
              onClick={() => { seek(s.startS + 0.01); ref.current?.pause() }} aria-label={`Legenda em ${fmt(s.startS)}: ${s.text}`} />
          ))}
          <span className="cursor" style={{ left: `${(time / video.durationS) * 100}%` }} />
        </div>
        <p className="muted small">Clique num bloco para ir até aquela legenda. Cada bloco é uma linha.</p>
      </div>

      <div className="panel">
        <div className="row"><h3 className="panel-title">Legenda neste momento</h3><span className="muted">{fmt(time)}</span></div>
        {cur ? (
          <>
            <input value={cur.text} maxLength={200} aria-label="Texto da legenda" onChange={(e) => setSeg(active, { text: e.target.value, highlights: cur.highlights.filter((h) => h < e.target.value.split(/\s+/).length) })} />
            <div className="words" style={{ fontFamily: track.fontFamily, fontWeight: track.fontWeight }}>
              {cur.text.split(/\s+/).filter(Boolean).map((w, j) => (
                <button type="button" key={j} onClick={() => toggle(active, j)} style={{ color: color(j, cur) }} aria-pressed={cur.highlights.includes(j)}>{w}</button>
              ))}
            </div>
            <p className="muted small">Clique numa palavra para destacar.</p>
            <div className="nudge">
              <span>Começa {fmt(cur.startS)}<button type="button" className="icon-btn" onClick={() => nudge(active, 'startS', -0.1)} aria-label="Começar 0,1 s antes">−</button><button type="button" className="icon-btn" onClick={() => nudge(active, 'startS', 0.1)} aria-label="Começar 0,1 s depois">+</button></span>
              <span>Termina {fmt(cur.endS)}<button type="button" className="icon-btn" onClick={() => nudge(active, 'endS', -0.1)} aria-label="Terminar 0,1 s antes">−</button><button type="button" className="icon-btn" onClick={() => nudge(active, 'endS', 0.1)} aria-label="Terminar 0,1 s depois">+</button></span>
            </div>
            <button type="button" className="link" onClick={() => set({ segments: segs.filter((_, j) => j !== active) })}>Apagar esta legenda</button>
          </>
        ) : (
          <>
            <p className="muted">Nenhuma legenda neste instante.</p>
            <button type="button" className="ghost-btn" onClick={() => {
              const t = Math.round(time * 10) / 10
              const end = Math.min(nextIdx >= 0 ? segs[nextIdx].startS : video.durationS, t + 2)
              set({ segments: [...segs, { startS: t, endS: Math.max(t + 0.5, end), text: 'Nova legenda', highlights: [] }].sort((a, b) => a.startS - b.startS) })
            }}>Adicionar legenda aqui</button>
          </>
        )}
        <div className="row">
          <button type="button" className="link" disabled={active <= 0 && nextIdx <= 0} onClick={() => { const i = active > 0 ? active - 1 : Math.max(0, nextIdx - 1); seek(segs[i].startS + 0.01) }}>← Anterior</button>
          <button type="button" className="link" disabled={(active >= 0 ? active + 1 : nextIdx) >= segs.length || nextIdx === -1 && active === -1} onClick={() => { const i = active >= 0 ? active + 1 : nextIdx; if (segs[i]) seek(segs[i].startS + 0.01) }}>Próxima →</button>
        </div>
        <footer className="modal-actions">
          <button type="button" className="link" onClick={() => setStyleOpen(true)}>Estilo da legenda</button>
          <span className="spacer" />
          {saved && <span className="ok">{saved}</span>}
          <button type="button" className="ghost-btn" onClick={() => act(async () => { await save(); setSaved('Salvo') }, reload)}>Salvar</button>
          <button type="button" disabled={busy} onClick={() => act(async () => { await save(); await api(`/projects/${id}/render`, { method: 'POST' }) }, reload)}>Salvar e renderizar</button>
        </footer>
      </div>

      <div className="panel">
        <span className="panel-title">Regerar com o Claude</span>
        <Requests {...props} part="caption" />
        <Regen {...props} part="caption" label="Regerar legenda" />
      </div>
      <History items={data.captionVersions.map((v) => ({ version: v.version, isCurrent: v.isCurrent, label: `${v.fontFamily} · ${v.segments} linhas · ${when(v.createdAt)}` }))}
        onRestore={(version) => act(() => api(`/projects/${id}/captions/restore`, { method: 'POST', body: { version } }), reload)} />

      <Modal open={styleOpen} onClose={() => setStyleOpen(false)} kicker="Legenda" title="Estilo da legenda">
        <div className="grid">
          <div className="field"><span className="field-label">Fonte</span><FontSelect value={track.fontFamily} fonts={allowed} onChange={(f) => set({ fontFamily: f })} /></div>
          <label>Peso<select value={track.fontWeight} onChange={(e) => set({ fontWeight: Number(e.target.value) })}><option value={400}>Normal</option><option value={700}>Negrito</option><option value={900}>Extra</option></select></label>
          <label>Tamanho<input type="number" min={24} max={140} value={track.size} onChange={(e) => set({ size: Number(e.target.value) })} /></label>
          <label className="check"><input type="checkbox" checked={track.outline !== false} onChange={(e) => set({ outline: e.target.checked })} /> Traçado nas letras</label>
          <div className="field"><span className="field-label">Posição</span><CaptionPosition value={track.position} onChange={(position) => set({ position })} /></div>
          <label>Cor<input type="color" value={track.color} onChange={(e) => set({ color: e.target.value.toUpperCase() })} /></label>
          <label>Cor do destaque<input type="color" value={track.highlightColor} onChange={(e) => set({ highlightColor: e.target.value.toUpperCase() })} /></label>
          <label>Destaque<select value={track.highlightMode} onChange={(e) => set({ highlightMode: e.target.value })}>
            <option value="palavra-chave">Palavras-chave</option><option value="karaokê">Karaokê</option><option value="manual">Manual</option>
          </select></label>
        </div>
        <footer className="modal-actions"><span className="spacer" /><button type="button" onClick={() => setStyleOpen(false)}>Pronto</button></footer>
      </Modal>
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
    <div className="cards">
      <div className="panel wide">
      <label>{label}
        {field === 'title'
          ? <input value={value} maxLength={100} onChange={(e) => setValue(e.target.value)} />
          : <textarea rows={field === 'description' ? 10 : 3} value={value} maxLength={5000} onChange={(e) => setValue(e.target.value)} />}
        {field === 'title' && <small className="muted">{value.length}/100</small>}
      </label>
      <div className="row"><span /><button type="button" disabled={value === current?.value}
        onClick={() => act(() => api(`/projects/${id}/metadata/${field}`, { method: 'PUT', body: { value } }), reload)}>Salvar versão</button></div>
      </div>
      <div className="panel">
        <span className="panel-title">Regerar com o Claude</span>
        <Requests {...props} part={field} />
        <Regen {...props} part={field} label="Regerar" />
      </div>
      <History items={versions.map((v) => ({ version: v.version, isCurrent: v.isCurrent, label: `${by(v.createdBy)} · ${when(v.createdAt)}`, preview: v.value }))}
        onRestore={(version) => act(() => api(`/projects/${id}/metadata/${field}/restore`, { method: 'POST', body: { version } }), reload)} />
    </div>
  )
}

function History({ items, onRestore }: { items: { version: number; isCurrent: boolean; label: string; preview?: string }[]; onRestore: (v: number) => void }) {
  if (!items.length) return null
  return (
    <div className="panel">
      <span className="panel-title">Histórico de versões · {items.length}</span>
      <ul className="history">{items.map((v) => (
        <li key={v.version}>
          <strong>v{v.version}</strong> <span className="muted">{v.label}</span> {v.isCurrent ? <em className="ok">· atual</em> : <button className="link" onClick={() => onRestore(v.version)}>voltar para esta</button>}
          {v.preview && <p className="pre muted">{v.preview.slice(0, 300)}</p>}
        </li>))}
      </ul>
    </div>
  )
}
