import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import { MUSIC_STYLES, type Part } from '@corte/shared'
import { api, uploadFont, useFonts } from './api'
import { ApprovePage } from './approve'
import { FontSelect, Modal, PageHead } from './ui'
import { ThumbnailTab } from './thumbnail'

type Segment = { startS: number; endS: number; text: string; highlights: number[] }
type Track = { version: number; fontFamily: string; fontWeight: number; size: number; color: string; highlightColor: string; highlightMode: string; position: string; outline?: boolean; segments: Segment[] }
type ChangeReq = { id: string; part: Part; frameTimeS: number | null; type: string; text: string; status: string; author: string; appliedInVersion: number | null; createdAt?: string }
type Meta = { field: string; version: number; value: string; isCurrent: boolean; createdBy: string; createdAt: string }
type Scene = { index: number; startS: number; endS: number; narration: string | null; onScreenText: string | null; motion: string | null; easing: string | null; transition: string | null; kind: 'card' | 'image' | 'video'; voiceId: string | null }
type TitleStyle = { fontFamily: string; size: number; color: string; bandColor: string; bandSize?: number; cardAlign?: string; bandAlign?: string; upper?: boolean }
type Options = { musicVolume: number; sfxVolume: number; titleStyle: TitleStyle | null; bgColor: string; musicStyle: string; voicePreset: string; voiceTone: string }
type EditData = {
  name: string
  status: string
  captionsOn: boolean
  job: { type: string; status: string; stage: string | null; progress: number } | null
  scenes: Scene[]
  music: { id: string; attribution: string | null } | null
  options: Options
  videos: { version: number; durationS: number; isCurrent: boolean; createdAt: string; changes: string[] | null }[]
  caption: Track | null
  captionVersions: { version: number; isCurrent: boolean; createdAt: string; fontFamily: string; segments: number }[]
  metadata: Meta[]
  changeRequests: ChangeReq[]
}
type Props = { id: string; data: EditData; reload: () => void; busy: boolean }

// Código de tempo no estilo dos editores: mm:ss:quadros (30 fps).
const tc = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}:${String(Math.floor((s % 1) * 30)).padStart(2, '0')}`
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const when = (d: string) => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
const by = (c: string) => (c === 'claude' ? 'Claude' : c === 'system' ? 'sistema' : 'você')
const MOTIONS: [string, string][] = [['ken_burns', 'Ken Burns (zoom lento)'], ['parallax', 'Parallax 2.5D'], ['cutout', 'Recorte de revista'], ['snap_zoom', 'Zoom rápido'], ['static', 'Parada']]
const EASINGS: [string, string][] = [['ease_in_out', 'Suave nas pontas'], ['ease_in', 'Começa lento'], ['ease_out', 'Termina lento'], ['linear', 'Constante']]
const TRANSITIONS: [string, string][] = [['cut', 'Corte seco'], ['fade', 'Dissolver'], ['zoom_through', 'Zoom através'], ['slide_left', 'Deslizar ←'], ['slide_right', 'Deslizar →'], ['slide_up', 'Deslizar ↑'], ['slide_down', 'Deslizar ↓'], ['whip', 'Chicote'], ['punch_in', 'Soco de zoom']]
const label = (list: [string, string][], v: string | null) => list.find(([k]) => k === v)?.[1] ?? '—'
const DEFAULT_TITLE: TitleStyle = { fontFamily: 'Montserrat', size: 154, color: '#FFFFFF', bandColor: '#FFD43B' }

async function act(fn: () => Promise<unknown>, reload: () => void) {
  try { await fn(); reload() } catch (e) { alert((e as Error).message) }
}

function useGoogleFont(family: string, weight: number) {
  useEffect(() => {
    const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&display=swap`
    if (document.querySelector(`link[href="${href}"]`)) return
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l)
  }, [family, weight])
}

// Edição do projeto: abre quando o vídeo fica pronto.
export function EditPage({ id }: { id: string }) {
  const [data, setData] = useState<EditData | null>(null)
  const [tab, setTab] = useState<'video' | 'ctx' | 'log' | 'pub'>('video')
  const [approve, setApprove] = useState(false)
  const [full, setFull] = useState(false)
  const [missing, setMissing] = useState(false)
  const load = () => api<EditData>(`/projects/${id}/edit`).then(setData, () => setMissing(true))
  useEffect(() => { load() }, [id])
  useEffect(() => {
    if (!data?.job) return
    const t = setTimeout(load, 2000)
    return () => clearTimeout(t)
  }, [data])
  // Tela cheia: só o editor, sem a barra lateral. Esc sai.
  useEffect(() => {
    document.body.classList.toggle('editor-full', full)
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false) }
    addEventListener('keydown', esc)
    return () => { document.body.classList.remove('editor-full'); removeEventListener('keydown', esc) }
  }, [full])

  if (missing) return <p>Projeto não encontrado. <a href="#/projetos">Voltar</a></p>
  if (!data) return null
  const video = data.videos.find((v) => v.isCurrent)
  const props = { id, data, reload: load, busy: !!data.job }
  return (
    <div className={`page editor-page${full ? ' is-full' : ''}`}>
      <PageHead back={{ href: '#/projetos', label: 'Projetos' }} kicker={data.status === 'approved' ? 'Aprovado' : 'Edição'} title={data.name}>
        {video && <a className="btn ghost" href={`/api/projects/${id}/video?download=1`}>Baixar MP4</a>}
        <button type="button" onClick={() => setApprove(true)} disabled={!video}>{data.status === 'approved' ? 'Cortes' : 'Aprovar'}</button>
      </PageHead>
      <div className="nle-tabs">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'video'} onClick={() => setTab('video')}>Edição</button>
          <button type="button" role="tab" aria-selected={tab === 'ctx'} onClick={() => setTab('ctx')}>Edição por contexto</button>
          <button type="button" role="tab" aria-selected={tab === 'log'} onClick={() => setTab('log')}>Versões</button>
          <button type="button" role="tab" aria-selected={tab === 'pub'} onClick={() => setTab('pub')}>Publicação</button>
        </div>
        <button type="button" className="icon-btn full-btn" onClick={() => setFull(!full)} aria-pressed={full} title={full ? 'Sair da tela cheia (Esc)' : 'Tela cheia'} aria-label={full ? 'Sair da tela cheia' : 'Tela cheia'}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">{full ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}</svg>
        </button>
      </div>
      {data.job && <p className="warn" role="status">{data.job.status === 'paused' ? 'Pausado' : 'Em andamento'}: {data.job.stage ?? data.job.type} · {data.job.progress}%</p>}
      {tab === 'video' && <VideoEditor {...props} />}
      {tab === 'ctx' && <ContextTab {...props} />}
      {tab === 'log' && <VersionLog data={data} />}
      {tab === 'pub' && <Publish {...props} />}
      <Modal open={approve} onClose={() => { setApprove(false); load() }} title={data.status === 'approved' ? 'Cortes' : 'Aprovar vídeo'} kicker="Aprovação" wide>
        <ApprovePage id={id} embedded />
      </Modal>
    </div>
  )
}

// ---------- Editor: cena e áudio | prévia | legenda e enunciado; timeline embaixo ----------
// Tudo o que muda fica em rascunho até "Salvar"; "Renderizar vídeo" salva e monta o vídeo com todas as mudanças juntas.
type Draft = { scenes: Record<number, Partial<Scene> & { durationS?: number }>; options: Partial<Options>; caption: boolean }
const EMPTY: Draft = { scenes: {}, options: {}, caption: false }
type Left = 'scene' | 'audio'
type Right = 'caption' | 'title'
type Ctx = Props & {
  time: number; seek: (t: number, fast?: boolean) => void; scenes: Scene[]; scene: Scene | undefined; options: Options
  track: Track; setTrack: (t: Track) => void; title: TitleStyle; segIdx: number
  stageScene: (index: number, patch: Partial<Scene> & { durationS?: number }) => void; stageOptions: (patch: Partial<Options>) => void
}

function VideoEditor(props: Props) {
  const { id, data, reload, busy } = props
  const ref = useRef<HTMLVideoElement>(null)
  const [time, setTime] = useState(0)
  const [left, setLeft] = useState<Left>('scene')
  const [right, setRight] = useState<Right>('caption')
  const [track, setTrackState] = useState<Track | null>(data.caption)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (!draft.caption) setTrackState(data.caption) }, [data.caption?.version])
  const options: Options = { ...data.options, ...draft.options }
  const title = options.titleStyle ?? DEFAULT_TITLE
  let shift = 0
  const scenes = data.scenes.map((s) => {
    const d = draft.scenes[s.index] ?? {}
    const startS = s.startS + shift
    const endS = d.durationS !== undefined ? startS + d.durationS : s.endS + shift
    shift = endS - s.endS
    return { ...s, ...d, startS, endS }
  })
  useGoogleFont(track?.fontFamily ?? 'Inter', track?.fontWeight ?? 700)
  useGoogleFont(title.fontFamily, 700)
  // Enquanto toca, o cursor anda a cada quadro (o timeupdate do navegador só avisa 4 vezes por segundo).
  useEffect(() => {
    let raf = 0
    const tick = () => { const v = ref.current; if (v && !v.paused) setTime(v.currentTime); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  const video = data.videos.find((v) => v.isCurrent)
  if (!video || !track) return <p className="muted">O editor abre quando o vídeo terminar de ser criado.</p>
  const dur = video.durationS
  const seek = (t: number, fast?: boolean) => {
    const v = Math.max(0, Math.min(dur - 0.05, t)); setTime(v)
    const el = ref.current; if (!el) return
    if (fast && 'fastSeek' in el) el.fastSeek(v); else el.currentTime = v
  }
  const scene = scenes.find((s) => time >= s.startS && time < s.endS) ?? scenes[0]
  const segIdx = track.segments.findIndex((s) => time >= s.startS && time < s.endS)
  const cur = segIdx >= 0 ? track.segments[segIdx] : null
  const hl = (w: number, s: Segment) => (s.highlights.includes(w) || track.highlightMode === 'karaokê' ? track.highlightColor : track.color)
  const stageScene = (index: number, patch: Partial<Scene> & { durationS?: number }) => setDraft((d) => ({ ...d, scenes: { ...d.scenes, [index]: { ...d.scenes[index], ...patch } } }))
  const stageOptions = (patch: Partial<Options>) => setDraft((d) => ({ ...d, options: { ...d.options, ...patch } }))
  const setTrack = (t: Track) => { setTrackState(t); setDraft((d) => ({ ...d, caption: true })) }
  const pending = Object.keys(draft.scenes).length + Object.keys(draft.options).length + (draft.caption ? 1 : 0)

  async function save() {
    for (const [index, patch] of Object.entries(draft.scenes)) {
      const { onScreenText, motion, easing, transition, durationS } = patch
      await api(`/projects/${id}/scenes/${index}`, { method: 'PATCH', body: { onScreenText, motion, easing, transition, durationS } })
    }
    if (Object.keys(draft.options).length) await api(`/projects/${id}/options`, { method: 'PATCH', body: draft.options })
    if (draft.caption) { const { version: _v, ...body } = track!; await api(`/projects/${id}/captions`, { method: 'PUT', body }) }
  }
  const run = (fn: () => Promise<unknown>) => { setSaving(true); act(async () => { await fn(); setDraft(EMPTY) }, reload).finally(() => setSaving(false)) }
  // Só a legenda mudou e ela já está no vídeo: troca só a legenda (rápido). O resto monta o vídeo de novo.
  const onlyCaption = draft.caption && !Object.keys(draft.scenes).length && !Object.keys(draft.options).length
  // Só texto/estilo dos enunciados (e talvez a legenda): os títulos são escritos sobre o vídeo atual, sem montar tudo de novo.
  const onlyTitles = Object.values(draft.scenes).every((p) => Object.keys(p).every((k) => k === 'onScreenText')) && Object.keys(draft.options).every((k) => k === 'titleStyle') && (Object.keys(draft.scenes).length > 0 || 'titleStyle' in draft.options)
  const render = () => run(async () => {
    await save()
    // Voz ou ritmo mudou: narra de novo (o vídeo é montado logo depois, com o resto das mudanças).
    if (draft.options.voicePreset !== undefined || draft.options.voiceTone !== undefined) await api(`/projects/${id}/revoice`, { method: 'POST' })
    else if (onlyCaption && data.captionsOn) await api(`/projects/${id}/captions/apply`, { method: 'POST', body: { on: true } })
    else await api(`/projects/${id}/render`, { method: 'POST', body: { titlesOnly: onlyTitles } })
  })
  const ctx: Ctx = { ...props, time, seek, scenes, scene, options, track, setTrack, title, segIdx, stageScene, stageOptions }

  return (
    <div className="editor">
      <div className="action-bar">
        <span className={pending ? 'pending' : 'muted'}>{pending ? `${pending} ${pending === 1 ? 'alteração' : 'alterações'} em rascunho` : 'Nenhuma alteração pendente'}</span>
        <span className="spacer" />
        {pending > 0 && <button type="button" className="link" disabled={saving} onClick={() => { setDraft(EMPTY); setTrackState(data.caption) }}>Descartar</button>}
        <button type="button" className="ghost-btn" disabled={!pending || saving} onClick={() => run(save)}>Salvar</button>
        <button type="button" disabled={busy || saving} onClick={render}>Renderizar vídeo</button>
      </div>

      <div className="nle-grid">
        <aside className="nle-panel">
          <div className="inspector-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={left === 'scene'} onClick={() => setLeft('scene')}>Cena</button>
            <button type="button" role="tab" aria-selected={left === 'audio'} onClick={() => setLeft('audio')}>Áudio</button>
          </div>
          <div className="inspector-body">{left === 'scene' ? <ScenePanel {...ctx} /> : <AudioPanel {...ctx} />}</div>
        </aside>

        <section className="nle-panel monitor">
          <header className="nle-head"><span>Programa · v{video.version}</span><span className="tc">{tc(time)} / {tc(dur)}</span></header>
          <div className="stage">
            {/* Vídeo limpo por baixo; legenda e enunciado desenhados por cima, para a prévia mudar na hora. */}
            <video ref={ref} className="player" controls preload="metadata" src={`/api/projects/${id}/video?v=${video.version}&clean=1`}
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} />
            {scene?.onScreenText && (scene.kind === 'card'
              ? <div className={`title-card ${(title.cardAlign ?? 'middle-center').replace('-', ' ')}`} style={{ fontFamily: title.fontFamily, color: title.color, fontSize: `${(title.size / 1920) * 100}cqw` }}>{title.upper === false ? scene.onScreenText : scene.onScreenText.toUpperCase()}</div>
              : time < scene.startS + 2.95 && <div className={`title-band ${(title.bandAlign ?? 'top-left').replace('-', ' ')}`} style={{ fontFamily: title.fontFamily, background: title.bandColor, fontSize: `${((title.bandSize ?? title.size * 0.4) / 1920) * 100}cqw` }}>{title.upper === false ? scene.onScreenText : scene.onScreenText.toUpperCase()}</div>)}
            {cur && !(scene?.kind === 'card' && scene.onScreenText) && (
              <div className={`caption-preview ${track.position.replace('-', ' ')}${track.outline === false ? ' no-outline' : ''}`}
                style={{ fontFamily: track.fontFamily, fontWeight: track.fontWeight, fontSize: `${(track.size / 1920) * 100}cqw` }}>
                {cur.text.split(/\s+/).filter(Boolean).map((w, j) => <span key={j} style={{ color: hl(j, cur) }}>{w} </span>)}
              </div>
            )}
            <span className="stage-tag">Prévia · legenda {data.captionsOn ? 'ligada' : 'desligada'} no vídeo final</span>
          </div>
        </section>

        <aside className="nle-panel">
          <div className="inspector-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={right === 'caption'} onClick={() => setRight('caption')}>Legenda</button>
            <button type="button" role="tab" aria-selected={right === 'title'} onClick={() => setRight('title')}>Enunciado</button>
          </div>
          <div className="inspector-body">{right === 'caption' ? <CaptionPanel {...ctx} /> : <TitlePanel {...ctx} />}</div>
        </aside>
      </div>

      <Timeline {...ctx} dur={dur} version={video.version}
        onPick={(layer) => { if (layer === 'scene' || layer === 'audio') setLeft(layer); else setRight(layer) }} />
    </div>
  )
}

// Linha do tempo: arraste em qualquer ponto para correr pelo vídeo; clique num bloco para editar aquela parte.
function Timeline({ id, data, track, time, seek, dur, version, onPick, scene, scenes, options }: Ctx & { dur: number; version: number; onPick: (l: Left | Right) => void }) {
  const [zoom, setZoom] = useState(60) // pixels por segundo
  const scroll = useRef<HTMLDivElement>(null)
  const lanes = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; moved: boolean; layer: string | null } | null>(null)
  const raf = useRef(0)
  const width = Math.max(dur * zoom, 600)
  const step = Math.max(1, Math.round(120 / zoom)) // um quadro a cada ~120 px
  const x = (t: number) => (t / dur) * width
  const box = (a: number, b: number): CSSProperties => ({ left: x(a), width: Math.max(4, x(b) - x(a)) })
  // Mantém o cursor à vista enquanto o vídeo toca (não mexe enquanto você arrasta).
  useEffect(() => {
    const el = scroll.current; if (!el || drag.current) return
    const px = x(time)
    if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = px - 80
  }, [Math.floor(time * 2), zoom])
  const at = (clientX: number) => ((clientX - lanes.current!.getBoundingClientRect().left) / width) * dur
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, moved: false, layer: (e.target as HTMLElement).closest<HTMLElement>('[data-layer]')?.dataset.layer ?? null }
    seek(at(e.clientX), true)
  }
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current; if (!d) return
    if (Math.abs(e.clientX - d.x) > 3) d.moved = true
    const cx = e.clientX
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => seek(at(cx), true))
    // Arrastando perto da borda, a timeline anda junto.
    const el = scroll.current!, r = el.getBoundingClientRect()
    if (cx > r.right - 30) el.scrollLeft += 12; else if (cx < r.left + 30) el.scrollLeft -= 12
  }
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current; drag.current = null
    if (!d) return
    seek(at(e.clientX))
    if (!d.moved && d.layer) onPick(d.layer as Left | Right)
  }
  const ticks = Array.from({ length: Math.min(400, Math.floor(dur / step) + 1) }, (_, i) => i * step)
  const transitions = scenes.filter((s, i) => i > 0 && s.transition && !['cut', 'fade'].includes(s.transition))
  return (
    <section className="nle-panel tl" aria-label="Linha do tempo">
      <div className="nle-head tl-head">
        <span>Linha do tempo</span>
        <span className="muted">{scene ? `cena ${scene.index + 1}` : ''}</span>
        <span className="spacer" />
        <label className="tl-zoom">Zoom<input type="range" min={15} max={240} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /></label>
      </div>
      <div className="tl-body">
        <div className="tl-labels">
          <span className="tc">{tc(time)}</span><span className="tall"><b>V3</b>Quadros</span><span><b>V2</b>Cenas</span><span><b>T1</b>Enunciados</span><span><b>T2</b>Legenda</span><span className="a"><b>A1</b>Narração</span><span className="a"><b>A2</b>Trilha</span><span className="a"><b>A3</b>Efeitos</span>
        </div>
        <div className="tl-scroll" ref={scroll}>
          <div className="tl-lanes" ref={lanes} style={{ width }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null }}>
            <div className="lane ruler">{ticks.map((t) => <span key={t} style={{ left: x(t) }}>{fmt(t)}</span>)}</div>
            <div className="lane frames">
              {ticks.filter((t) => t < dur).map((t) => <img key={t} draggable={false} src={`/api/projects/${id}/frame?t=${Math.min(dur - 0.1, t + step / 2).toFixed(1)}&v=${version}`} alt="" loading="lazy" style={{ left: x(t), width: x(step) - 1 }} />)}
              {data.changeRequests.filter((c) => c.part === 'video' && c.frameTimeS != null).map((c) => (
                <span key={c.id} className={`marker ${c.status}`} style={{ left: x(c.frameTimeS!) }} title={c.text} />
              ))}
            </div>
            <div className="lane">
              {scenes.map((s) => (
                <span key={s.index} data-layer="scene" className={`blk scene ${s.kind}${scene?.index === s.index ? ' on' : ''}`} style={box(s.startS, s.endS)}
                  title={`Cena ${s.index + 1}: ${s.kind === 'card' ? 'cartela' : label(MOTIONS, s.motion)}`}>
                  {s.index + 1} · {s.kind === 'card' ? 'Cartela' : s.kind === 'video' ? 'Vídeo' : label(MOTIONS, s.motion)}
                </span>
              ))}
            </div>
            <div className="lane">
              {scenes.filter((s) => s.onScreenText).map((s) => (
                <span key={s.index} data-layer="title" className="blk title" style={box(s.startS, s.kind === 'card' ? s.endS : Math.min(s.endS, s.startS + 2.95))} title={s.onScreenText!}>{s.onScreenText}</span>
              ))}
            </div>
            <div className="lane">
              {track.segments.map((s, i) => <span key={i} data-layer="caption" className="blk cap" style={box(s.startS, s.endS)} title={s.text}>{s.text}</span>)}
            </div>
            <div className="lane">
              {scenes.filter((s) => s.narration?.trim()).map((s) => <span key={s.index} data-layer="audio" className="blk voice" style={box(s.startS, s.endS)} title={s.narration!}>{s.narration}</span>)}
            </div>
            <div className="lane">
              {options.musicStyle !== 'none' && options.musicVolume > 0
                ? <span data-layer="audio" className="blk music" style={box(0, dur)}>Trilha · {MUSIC_STYLES.find((m) => m.id === options.musicStyle)?.label ?? ''} · {options.musicVolume}%</span>
                : <span className="lane-empty">sem trilha</span>}
            </div>
            <div className="lane">
              {options.sfxVolume > 0
                ? transitions.map((s) => <span key={s.index} data-layer="audio" className="blk sfx" style={box(s.startS - 0.25, s.startS + 0.35)} title={label(TRANSITIONS, s.transition)} />)
                : <span className="lane-empty">efeitos desligados</span>}
            </div>
            <span className="tl-cursor" style={{ left: x(time) }} />
          </div>
        </div>
      </div>
    </section>
  )
}

// ---------- Card da esquerda: cena e áudio ----------
function ScenePanel({ scene, scenes, stageScene }: Ctx) {
  const [asDefault, setAsDefault] = useState(false)
  const [applied, setApplied] = useState('')
  useEffect(() => { api<{ durationS: number | null }>('/me/card-duration').then((r) => setAsDefault(r.durationS !== null)).catch(() => {}) }, [])
  useEffect(() => setApplied(''), [scene?.index])
  if (!scene) return null
  const patch = (p: Partial<Scene> & { durationS?: number }) => stageScene(scene.index, p)
  const silent = !scene.narration?.trim()
  return (
    <div className="stack-sm">
      <div className="row"><strong>Cena {scene.index + 1}</strong><span className="muted">{fmt(scene.startS)}–{fmt(scene.endS)} · {scene.kind === 'card' ? 'cartela' : scene.kind === 'video' ? 'vídeo' : 'foto'}</span></div>
      {scene.narration && <p className="muted small">“{scene.narration}”</p>}
      {scene.kind === 'card' && (
        <label>Texto da cartela
          <input value={scene.onScreenText ?? ''} maxLength={120} placeholder="Título deste bloco" onChange={(e) => patch({ onScreenText: e.target.value })} />
        </label>
      )}
      {silent && (
        <label>Duração do bloco
          <span className="dur-row">
            <input type="range" min={0.5} max={10} step={0.1} value={Math.round((scene.endS - scene.startS) * 10) / 10} onChange={(e) => patch({ durationS: Number(e.target.value) })} />
            <b>{(scene.endS - scene.startS).toFixed(1)} s</b>
          </span>
          <small className="muted">O próximo bloco começa logo depois.</small>
        </label>
      )}
      {scene.kind === 'card' && (
        <div className="apply-all">
          <button type="button" className="ghost-btn" onClick={async () => {
            const d = Math.round((scene.endS - scene.startS) * 10) / 10
            const cards = scenes.filter((x) => x.kind === 'card' && !x.narration?.trim())
            for (const c of cards) stageScene(c.index, { durationS: d })
            if (asDefault) await api('/me/card-duration', { method: 'PUT', body: { durationS: d } }).catch(() => {})
            setApplied(`${d.toFixed(1)} s em ${cards.length} ${cards.length === 1 ? 'cartela' : 'cartelas'}${asDefault ? ' · padrão salvo' : ''}`)
          }}>Aplicar a todas as cartelas</button>
          <label className="check"><input type="checkbox" checked={asDefault} onChange={(e) => {
            setAsDefault(e.target.checked)
            if (!e.target.checked) api('/me/card-duration', { method: 'PUT', body: { durationS: null } }).catch(() => {})
          }} /> Tornar padrão nos próximos vídeos</label>
          {applied && <small className="ok">✓ {applied}</small>}
        </div>
      )}
      {scene.kind === 'image' && (
        <>
          <label>Motion<select value={scene.motion ?? 'ken_burns'} onChange={(e) => patch({ motion: e.target.value })}>{MOTIONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Curva do movimento<select value={scene.easing ?? 'ease_in_out'} onChange={(e) => patch({ easing: e.target.value })}>{EASINGS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        </>
      )}
      {scene.index > 0 && <label>Transição de entrada<select value={scene.transition ?? 'cut'} onChange={(e) => patch({ transition: e.target.value })}>{TRANSITIONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
    </div>
  )
}

// Player compacto no estilo do sistema: tocar/pausar, barra e tempo.
function MiniPlayer({ src, label }: { src: string; label: string }) {
  const ref = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const [d0, setD] = useState(0)
  const d = Number.isFinite(d0) ? d0 : 0 // alguns WAV só informam a duração depois de tocar
  return (
    <div className="mini-player">
      <audio ref={ref} src={src} preload="metadata" onLoadedMetadata={(e) => setD(e.currentTarget.duration)} onDurationChange={(e) => setD(e.currentTarget.duration)} onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      <button type="button" className="icon-btn" aria-label={playing ? `Pausar ${label}` : `Tocar ${label}`} onClick={() => (playing ? ref.current?.pause() : ref.current?.play())}>{playing ? '❚❚' : '▶'}</button>
      <input type="range" min={0} max={d || 1} step={0.1} value={t} aria-label={`Posição: ${label}`} onChange={(e) => { if (ref.current) ref.current.currentTime = Number(e.target.value) }} />
      <span className="tc">{fmt(t)}/{fmt(d)}</span>
    </div>
  )
}

function AudioPanel({ id, data, scene, options, stageOptions }: Ctx) {
  const [voices, setVoices] = useState<{ voices: { id: string; label: string }[]; current: string | null; tones: readonly { id: string; label: string }[] } | null>(null)
  useEffect(() => { api<NonNullable<typeof voices>>('/voices').then(setVoices).catch(() => {}) }, [])
  const voice = options.voicePreset || voices?.current || ''
  const changedVoice = options.voicePreset !== data.options.voicePreset || options.voiceTone !== data.options.voiceTone
  return (
    <div className="stack-sm">
      <span className="panel-title">Narração</span>
      <label>Voz<select value={voice} onChange={(e) => stageOptions({ voicePreset: e.target.value })}>
        {voices?.voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
      </select></label>
      <label>Ritmo<select value={options.voiceTone} onChange={(e) => stageOptions({ voiceTone: e.target.value })}>
        {(voices?.tones ?? []).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select></label>
      {changedVoice && <p className="muted small">Ao renderizar, a narração é feita de novo com esta voz.</p>}
      {scene?.voiceId ? <MiniPlayer src={`/api/projects/${id}/assets/${scene.voiceId}`} label={`narração da cena ${scene.index + 1}`} /> : <p className="muted small">Sem narração nesta cena.</p>}
      <span className="panel-title">Trilha</span>
      <label>Estilo<select value={options.musicStyle} onChange={(e) => stageOptions({ musicStyle: e.target.value })}>
        {MUSIC_STYLES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select></label>
      {data.music && options.musicStyle === data.options.musicStyle && <MiniPlayer src={`/api/projects/${id}/assets/${data.music.id}`} label="trilha" />}
      {options.musicStyle !== 'none' && (!data.music || options.musicStyle !== data.options.musicStyle) && <p className="muted small">A música é buscada ao renderizar.</p>}
      <label className="range-row">Volume<input type="range" min={0} max={80} step={5} value={options.musicVolume} onChange={(e) => stageOptions({ musicVolume: Number(e.target.value) })} /><b>{options.musicVolume ? `${options.musicVolume}%` : 'mudo'}</b></label>
      <span className="panel-title">Efeitos sonoros</span>
      <label className="range-row">Volume<input type="range" min={0} max={100} step={5} value={options.sfxVolume} onChange={(e) => stageOptions({ sfxVolume: Number(e.target.value) })} /><b>{options.sfxVolume ? `${options.sfxVolume}%` : 'desligado'}</b></label>
    </div>
  )
}

// ---------- Card da direita: legenda e enunciado ----------
const PRESETS: { id: string; name: string; style: Partial<Track> }[] = [
  { id: 'classica', name: 'Clássica', style: { fontFamily: 'Montserrat', fontWeight: 700, size: 64, color: '#FFFFFF', highlightColor: '#FFFFFF', highlightMode: 'manual', position: 'bottom-center', outline: true } },
  { id: 'destaque', name: 'Destaque', style: { fontFamily: 'Montserrat', fontWeight: 900, size: 72, color: '#FFFFFF', highlightColor: '#FFD43B', highlightMode: 'palavra-chave', position: 'bottom-center', outline: true } },
  { id: 'karaoke', name: 'Karaokê', style: { fontFamily: 'Poppins', fontWeight: 900, size: 76, color: '#FFFFFF', highlightColor: '#40C057', highlightMode: 'karaokê', position: 'middle-center', outline: true } },
  { id: 'minimal', name: 'Discreta', style: { fontFamily: 'Inter', fontWeight: 400, size: 52, color: '#F1F3F5', highlightColor: '#F1F3F5', highlightMode: 'manual', position: 'bottom-center', outline: false } },
]

function PresetCard({ p, on, onPick }: { p: (typeof PRESETS)[number]; on: boolean; onPick: () => void }) {
  const st = p.style
  useGoogleFont(st.fontFamily!, st.fontWeight!)
  const [v] = st.position!.split('-')
  return (
    <button type="button" className={`preset${on ? ' on' : ''}`} aria-pressed={on} onClick={onPick}>
      <span className={`preset-screen ${v}`}>
        <span className={st.outline ? 'outlined' : ''} style={{ fontFamily: st.fontFamily, fontWeight: st.fontWeight, color: st.color }}>Aqui o <span style={{ color: st.highlightColor }}>café</span> começa</span>
      </span>
      <span className="preset-name">{p.name}</span>
    </button>
  )
}

// Alinhamento da legenda em ícones: vertical (cima, meio, baixo) e horizontal (esquerda, centro, direita).
function AlignIcons({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [v, h = 'center'] = value.split('-')
  const V: [string, string, string][] = [['top', 'Em cima', 'M4 4h16M8 9h8M10 14h4'], ['middle', 'No meio', 'M4 12h16M8 7h8M8 17h8'], ['bottom', 'Embaixo', 'M4 20h16M8 15h8M10 10h4']]
  const H: [string, string, string][] = [['left', 'À esquerda', 'M4 6h16M4 10h10M4 14h16M4 18h10'], ['center', 'Centralizada', 'M4 6h16M7 10h10M4 14h16M7 18h10'], ['right', 'À direita', 'M4 6h16M10 10h10M4 14h16M10 18h10']]
  const icon = (d: string) => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d={d} /></svg>
  return (
    <div className="align-icons">
      <div className="seg" role="radiogroup" aria-label="Alinhamento vertical">{V.map(([k, l, d]) => <button key={k} type="button" role="radio" aria-checked={v === k} title={l} aria-label={l} onClick={() => onChange(`${k}-${h}`)}>{icon(d)}</button>)}</div>
      <div className="seg" role="radiogroup" aria-label="Alinhamento horizontal">{H.map(([k, l, d]) => <button key={k} type="button" role="radio" aria-checked={h === k} title={l} aria-label={l} onClick={() => onChange(`${v}-${k}`)}>{icon(d)}</button>)}</div>
    </div>
  )
}

// Legenda: na primeira vez, escolhe um estilo pronto e gera. Depois, edita como uma transcrição (uma linha por fala).
function CaptionPanel({ id, data, reload, busy, track, setTrack, time, seek, segIdx }: Ctx) {
  const fonts = useFonts()
  const [more, setMore] = useState(false)
  const [generating, setGenerating] = useState(!data.captionsOn && data.captionVersions.length <= 1)
  const listRef = useRef<HTMLOListElement>(null)
  const segs = track.segments
  const set = (patch: Partial<Track>) => setTrack({ ...track, ...patch })
  const setSeg = (i: number, patch: Partial<Segment>) => set({ segments: segs.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const nudge = (i: number, key: 'startS' | 'endS', d: number) => setSeg(i, { [key]: Math.max(0, Math.round((segs[i][key] + d) * 10) / 10) })
  const preset = PRESETS.find((p) => Object.entries(p.style).every(([k, v]) => track[k as keyof Track] === v))
  useEffect(() => { listRef.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }) }, [segIdx])

  if (generating) return (
    <div className="stack-sm">
      <p className="lead">Escolha como a legenda vai aparecer. O texto sai da narração; depois você ajusta palavra por palavra.</p>
      <div className="presets">{PRESETS.map((p) => <PresetCard key={p.id} p={p} on={preset?.id === p.id} onPick={() => set(p.style)} />)}</div>
      <button type="button" disabled={busy} onClick={() => act(async () => {
        const { version: _v, ...body } = track
        await api(`/projects/${id}/captions`, { method: 'PUT', body })
        await api(`/projects/${id}/captions/apply`, { method: 'POST', body: { on: true } })
        setGenerating(false)
      }, reload)}>Gerar legenda no vídeo</button>
      <button type="button" className="link" onClick={() => setGenerating(false)}>Editar o texto antes de gerar</button>
    </div>
  )

  return (
    <div className="cap-editor">
      <div className="cap-styles">
        {PRESETS.map((p) => <button key={p.id} type="button" className={`chip${preset?.id === p.id ? ' on' : ''}`} onClick={() => set(p.style)}>{p.name}</button>)}
        <button type="button" className={`chip${more ? ' on' : ''}`} onClick={() => setMore(!more)}>Ajustes</button>
      </div>
      <AlignIcons value={track.position} onChange={(position) => set({ position })} />
      {more && (
        <div className="cap-more">
          <div className="font-row">
            <FontSelect value={track.fontFamily} fonts={fonts} onChange={(f) => set({ fontFamily: f })} />
            <label className="chip upload-chip" title="Enviar uma fonte .ttf ou .otf">+
              <input type="file" accept=".ttf,.otf,font/ttf,font/otf" hidden onChange={async (e) => {
                const f = e.target.files?.[0]; e.target.value = ''
                if (f) await uploadFont(f).then((fontFamily) => set({ fontFamily }), (err) => alert((err as Error).message))
              }} />
            </label>
          </div>
          <div className="grid2">
            <label>Peso<select value={track.fontWeight} onChange={(e) => set({ fontWeight: Number(e.target.value) })}><option value={400}>Normal</option><option value={700}>Negrito</option><option value={900}>Extra</option></select></label>
            <label>Tamanho<input type="number" min={24} max={140} value={track.size} onChange={(e) => set({ size: Number(e.target.value) })} /></label>
            <label>Cor<input type="color" value={track.color} onChange={(e) => set({ color: e.target.value.toUpperCase() })} /></label>
            <label>Destaque<input type="color" value={track.highlightColor} onChange={(e) => set({ highlightColor: e.target.value.toUpperCase() })} /></label>
            <label>Modo<select value={track.highlightMode} onChange={(e) => set({ highlightMode: e.target.value })}><option value="palavra-chave">Palavras-chave</option><option value="karaokê">Karaokê</option><option value="manual">Manual</option></select></label>
            <label className="check"><input type="checkbox" checked={track.outline !== false} onChange={(e) => set({ outline: e.target.checked })} /> Traçado</label>
          </div>
        </div>
      )}

      <ol className="transcript" ref={listRef}>
        {segs.map((s, i) => (
          <li key={i} className={i === segIdx ? 'on' : ''}>
            <button type="button" className="tc-chip" onClick={() => seek(s.startS + 0.01)} title="Ir para esta fala">{fmt(s.startS)}</button>
            <div className="line">
              <input value={s.text} maxLength={200} aria-label={`Legenda em ${fmt(s.startS)}`} onFocus={() => seek(s.startS + 0.01)}
                onChange={(e) => setSeg(i, { text: e.target.value, highlights: s.highlights.filter((h) => h < e.target.value.split(/\s+/).length) })} />
              {i === segIdx && (
                <div className="line-tools">
                  <span className="words">{s.text.split(/\s+/).filter(Boolean).map((w, j) => (
                    <button type="button" key={j} aria-pressed={s.highlights.includes(j)} title="Destacar"
                      onClick={() => setSeg(i, { highlights: s.highlights.includes(j) ? s.highlights.filter((x) => x !== j) : [...s.highlights, j] })}>{w}</button>
                  ))}</span>
                  <span className="nudge">
                    <button type="button" className="icon-btn" onClick={() => nudge(i, 'startS', -0.1)} aria-label="Começar antes">−</button>início<button type="button" className="icon-btn" onClick={() => nudge(i, 'startS', 0.1)} aria-label="Começar depois">+</button>
                    <button type="button" className="icon-btn" onClick={() => nudge(i, 'endS', -0.1)} aria-label="Terminar antes">−</button>fim<button type="button" className="icon-btn" onClick={() => nudge(i, 'endS', 0.1)} aria-label="Terminar depois">+</button>
                  </span>
                </div>
              )}
            </div>
            <button type="button" className="icon-btn del" onClick={() => set({ segments: segs.filter((_, j) => j !== i) })} aria-label="Apagar esta legenda">×</button>
          </li>
        ))}
      </ol>
      <div className="row wrap">
        <button type="button" className="link" onClick={() => {
          const t = Math.round(time * 10) / 10
          set({ segments: [...segs, { startS: t, endS: t + 2, text: 'Nova legenda', highlights: [] }].sort((a, b) => a.startS - b.startS) })
        }}>+ Legenda em {fmt(time)}</button>
        <span className="spacer" />
        {data.captionsOn
          ? <button type="button" className="link" disabled={busy} onClick={() => act(() => api(`/projects/${id}/captions/apply`, { method: 'POST', body: { on: false } }), reload)}>Tirar a legenda do vídeo</button>
          : <button type="button" className="link" disabled={busy} onClick={() => act(() => api(`/projects/${id}/captions/apply`, { method: 'POST', body: { on: true } }), reload)}>Ligar a legenda no vídeo</button>}
      </div>
    </div>
  )
}

// Enunciado: edita o da cena em que o cursor está. O estilo vale para todos.
function TitlePanel({ scene, title, stageScene, stageOptions }: Ctx) {
  const fonts = useFonts()
  const setTitle = (patch: Partial<TitleStyle>) => stageOptions({ titleStyle: { ...title, ...patch } })
  return (
    <div className="stack-sm">
      {scene && (
        <label>Enunciado da cena {scene.index + 1} {scene.kind === 'card' ? '(cartela)' : '(faixa sobre a imagem)'}
          <input value={scene.onScreenText ?? ''} maxLength={120} placeholder="Sem enunciado nesta cena" onChange={(e) => stageScene(scene.index, { onScreenText: e.target.value })} />
        </label>
      )}
      <span className="panel-title">Estilo de todos os enunciados</span>
      <div className="field"><span className="field-label">Fonte</span><FontSelect value={title.fontFamily} fonts={fonts} onChange={(fontFamily) => setTitle({ fontFamily })} /></div>
      <label className="check"><input type="checkbox" checked={title.upper !== false} onChange={(e) => setTitle({ upper: e.target.checked })} /> Tudo em maiúsculas</label>

      <span className="field-label">Cartela (título do bloco)</span>
      <AlignIcons value={title.cardAlign ?? 'middle-center'} onChange={(cardAlign) => setTitle({ cardAlign })} />
      <label className="range-row">Tamanho<input type="range" min={60} max={260} value={title.size} onChange={(e) => setTitle({ size: Number(e.target.value) })} /><b>{title.size}</b></label>
      <label>Cor do texto<input type="color" value={title.color} onChange={(e) => setTitle({ color: e.target.value.toUpperCase() })} /></label>

      <span className="field-label">Faixa sobre a imagem</span>
      <AlignIcons value={title.bandAlign ?? 'top-left'} onChange={(bandAlign) => setTitle({ bandAlign })} />
      <label className="range-row">Tamanho<input type="range" min={24} max={140} value={title.bandSize ?? Math.round(title.size * 0.4)} onChange={(e) => setTitle({ bandSize: Number(e.target.value) })} /><b>{title.bandSize ?? Math.round(title.size * 0.4)}</b></label>
      <label>Cor da faixa<input type="color" value={title.bandColor} onChange={(e) => setTitle({ bandColor: e.target.value.toUpperCase() })} /></label>
    </div>
  )
}

// ---------- Edição por contexto: assiste, escreve o que mudar em cada momento e renderiza tudo junto ----------
function ContextTab({ id, data, reload, busy }: Props) {
  const ref = useRef<HTMLVideoElement>(null)
  const [time, setTime] = useState(0)
  const [text, setText] = useState('')
  const video = data.videos.find((v) => v.isCurrent)
  if (!video) return <p className="muted">O vídeo ainda não foi criado.</p>
  const dur = video.durationS
  const seek = (t: number) => { if (ref.current) ref.current.currentTime = t; setTime(t) }
  const drafts = data.changeRequests.filter((c) => c.part === 'video' && c.status === 'open')
  return (
    <div className="ctx-grid">
      <section className="nle-panel monitor">
        <header className="nle-head"><span>Prévia</span><span className="tc">{tc(time)} / {tc(dur)}</span></header>
        <div className="stage"><video ref={ref} className="player" controls preload="metadata" src={`/api/projects/${id}/video?v=${video.version}`} onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} /></div>
      </section>
      <section className="nle-panel ctx-card">
        <header className="nle-head"><span>O que mudar?</span><span className="tc">{tc(time)}</span></header>
        <div className="ctx-body">
          <textarea value={text} maxLength={1000} placeholder="Pause no momento e descreva a mudança. Ex.: troque esta foto por uma do produto de perto; deixe esta fala mais curta." onChange={(e) => setText(e.target.value)} />
          <button type="button" className="ghost-btn" disabled={!text.trim()} onClick={() => act(async () => {
            await api(`/projects/${id}/change-requests`, { method: 'POST', body: { part: 'video', frameTimeS: Math.round(time * 10) / 10, type: 'outro', text } }); setText('')
          }, reload)}>Salvar no rascunho</button>
          <ol className="drafts">
            {drafts.map((c) => (
              <li key={c.id}>
                <button type="button" className="tc-chip" onClick={() => seek(c.frameTimeS ?? 0)}>{fmt(c.frameTimeS ?? 0)}</button>
                <span>{c.text}</span>
                <button type="button" className="icon-btn del" aria-label="Tirar do rascunho" onClick={() => act(() => api(`/projects/${id}/change-requests/${c.id}`, { method: 'DELETE' }), reload)}>×</button>
              </li>
            ))}
            {!drafts.length && <li className="muted small">Nenhuma mudança no rascunho ainda.</li>}
          </ol>
          <button type="button" disabled={busy || !drafts.length} onClick={() => act(() => api(`/projects/${id}/regen`, { method: 'POST', body: { part: 'video' } }), reload)}>
            Renderizar vídeo{drafts.length ? ` com ${drafts.length} ${drafts.length === 1 ? 'mudança' : 'mudanças'}` : ''}
          </button>
        </div>
      </section>
    </div>
  )
}

// ---------- Versões: só para consulta, o que foi pedido de uma versão para a outra ----------
function VersionLog({ data }: { data: EditData }) {
  const versions = [...data.videos].sort((a, b) => b.version - a.version)
  return (
    <ol className="version-log">
      {versions.map((v) => {
        const asks = data.changeRequests.filter((c) => c.appliedInVersion === v.version)
        return (
          <li key={v.version} className="nle-panel">
            <header className="nle-head"><span>Versão {v.version}{v.isCurrent ? ' · atual' : ''}</span><span className="tc">{fmt(v.durationS)}</span><span>{when(v.createdAt)}</span></header>
            <div className="ctx-body">
              {v.version === 1 && !asks.length && !v.changes?.length && <p className="muted small">Primeira versão, criada a partir do roteiro.</p>}
              {v.version > 1 && !asks.length && !v.changes?.length && <p className="muted small">{v.changes ? 'Renderizada de novo, sem mudanças anotadas.' : 'Versão anterior ao registro detalhado das mudanças.'}</p>}
              {asks.length > 0 && (
                <><span className="log-tag">Pedidos ao Claude</span>
                <ul className="change-list">{asks.map((c) => <li key={c.id}>{c.frameTimeS != null && <b className="tc">{fmt(c.frameTimeS)}</b>}<span>{c.text}</span><small className="muted">{c.author}</small></li>)}</ul></>
              )}
              {!!v.changes?.length && (
                <><span className="log-tag">Mudanças no editor · {v.changes.length}</span>
                <ul className="change-list">{v.changes.map((c, i) => { const [where, what] = c.includes(': ') ? [c.slice(0, c.indexOf(': ')), c.slice(c.indexOf(': ') + 2)] : ['', c]; return <li key={i}>{where && <b>{where}</b>}<span>{what}</span></li> })}</ul></>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

// ---------- Publicação: título, descrição, palavras-chave e thumbnail numa tela só ----------
function Publish(props: Props) {
  const { id, data } = props
  const video = data.videos.find((v) => v.isCurrent) ?? null
  return (
    <div className="publish">
      <div className="publish-fields">
        <MetaField {...props} field="title" />
        <MetaField {...props} field="description" />
        <MetaField {...props} field="keywords" />
      </div>
      <div className="publish-side">
        <ThumbnailTab id={id} video={video} title={data.metadata.find((m) => m.field === 'title' && m.isCurrent)?.value ?? ''} />
      </div>
    </div>
  )
}

function MetaField({ id, data, reload, busy, field }: Props & { field: 'title' | 'description' | 'keywords' }) {
  const versions = data.metadata.filter((m) => m.field === field)
  const current = versions.find((m) => m.isCurrent)
  const [value, setValue] = useState(current?.value ?? '')
  useEffect(() => setValue(current?.value ?? ''), [current?.version])
  const name = { title: 'Título', description: 'Descrição', keywords: 'Palavras-chave' }[field]
  const words = value.split(',').map((w) => w.trim()).filter(Boolean)
  return (
    <section className="meta-card">
      <header className="row"><span className="panel-title">{name}</span>
        {field === 'title' && <small className="muted">{value.length}/100</small>}
        {field === 'keywords' && <small className="muted">{words.length} palavras</small>}
      </header>
      {field === 'title' && <input value={value} maxLength={100} onChange={(e) => setValue(e.target.value)} />}
      {field === 'description' && <textarea rows={9} value={value} maxLength={5000} onChange={(e) => setValue(e.target.value)} />}
      {field === 'keywords' && (
        <>
          <div className="chips">{words.map((w, i) => (
            <span key={i} className="chip">{w}<button type="button" className="chip-x" aria-label={`Tirar ${w}`} onClick={() => setValue(words.filter((_, j) => j !== i).join(', '))}>×</button></span>
          ))}</div>
          <input placeholder="Digite e aperte Enter para acrescentar" onKeyDown={(e) => {
            const v = e.currentTarget.value.trim()
            if (e.key === 'Enter' && v) { e.preventDefault(); setValue([...words, v].join(', ')); e.currentTarget.value = '' }
          }} />
        </>
      )}
      <div className="row wrap">
        <button type="button" disabled={value === (current?.value ?? '')} onClick={() => act(() => api(`/projects/${id}/metadata/${field}`, { method: 'PUT', body: { value } }), reload)}>Salvar</button>
        <span className="spacer" />
        <Regen id={id} reload={reload} busy={busy} part={field} label="Pedir ao Claude" />
      </div>
      <History items={versions.map((v) => ({ version: v.version, isCurrent: v.isCurrent, label: `${by(v.createdBy)} · ${when(v.createdAt)}`, preview: v.value }))}
        onRestore={(version) => act(() => api(`/projects/${id}/metadata/${field}/restore`, { method: 'POST', body: { version } }), reload)} />
    </section>
  )
}

// Regerar uma parte: o pedido opcional vira um pedido de alteração, e o Claude aplica todos os abertos.
function Regen({ id, part, reload, busy, label: name }: { id: string; part: Part; reload: () => void; busy: boolean; label: string }) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  async function go() {
    if (text.trim()) await api(`/projects/${id}/change-requests`, { method: 'POST', body: { part, text } })
    await api(`/projects/${id}/regen`, { method: 'POST', body: { part } })
    setText('')
  }
  if (!open) return <button type="button" className="link" onClick={() => setOpen(true)}>{name}</button>
  return (
    <div className="regen">
      <input placeholder="O que mudar? (opcional) Ex.: mais curto, mais emoção" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
      <button type="button" className="ghost-btn" disabled={busy} onClick={() => act(go, reload)}>{name}</button>
    </div>
  )
}

function History({ items, onRestore }: { items: { version: number; isCurrent: boolean; label: string; preview?: string }[]; onRestore: (v: number) => void }) {
  if (items.length < 2) return null
  return (
    <details className="history-box">
      <summary>Histórico de versões · {items.length}</summary>
      <ul className="history">{items.map((v) => (
        <li key={v.version}>
          <strong>v{v.version}</strong> <span className="muted">{v.label}</span> {v.isCurrent ? <em className="ok">· atual</em> : <button className="link" onClick={() => onRestore(v.version)}>voltar para esta</button>}
          {v.preview && <p className="pre muted">{v.preview.slice(0, 200)}</p>}
        </li>))}
      </ul>
    </details>
  )
}
