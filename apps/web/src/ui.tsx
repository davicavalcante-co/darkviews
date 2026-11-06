import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './icons'

// Cabeçalho de página: rótulo pequeno, título grande e ações à direita, com régua grossa embaixo.
export function PageHead({ kicker, title, children, back }: { kicker?: string; title: ReactNode; children?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <header className="page-head">
      <div>
        {back && <a className="back" href={back.href}>← {back.label}</a>}
        {kicker && <span className="kicker">{kicker}</span>}
        <h1>{title}</h1>
      </div>
      {children && <div className="actions">{children}</div>}
    </header>
  )
}

// Seção numerada da grade (01, 02...): régua fina, índice e título em caixa alta.
export function Section({ idx, title, aside, children }: { idx: number; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head"><span className="idx">{String(idx).padStart(2, '0')}</span><h2>{title}</h2>{aside && <div className="aside">{aside}</div>}</div>
      {children}
    </section>
  )
}

// Popup com o <dialog> nativo: foco, tecla Esc e fundo escurecido já vêm do navegador.
export function Modal({ open, onClose, title, kicker, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; kicker?: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} className={`modal${wide ? ' wide' : ''}`} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose() }}>
      {open && (
        <div className="modal-body">
          <header className="modal-head">
            <div>{kicker && <span className="kicker">{kicker}</span>}<h2>{title}</h2></div>
            <button type="button" className="icon-btn close" onClick={onClose} aria-label="Fechar">✕</button>
          </header>
          {children}
        </div>
      )}
    </dialog>
  )
}

// Passo a passo numerado e grande, para ler sem esforço.
export function Steps({ steps }: { steps: ReactNode[] }) {
  return <ol className="steps">{steps.map((s, i) => <li key={i}><span className="step-n">{i + 1}</span><div>{s}</div></li>)}</ol>
}

// Carrega a fonte do Google Fonts no navegador, para a prévia (fonte enviada pelo admin cai na fonte padrão).
export function loadFontPreview(family: string) {
  const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}&display=swap`
  if (!family || document.querySelector(`link[href="${href}"]`)) return
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l)
}

// Seletor de fonte com prévia: cada opção aparece escrita na própria fonte (o <select> nativo do Mac ignora isso).
export function FontSelect({ value, fonts, onChange, label = 'Fonte das legendas' }: { value: string; fonts: string[]; onChange: (f: string) => void; label?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const list = [...new Set([value, ...fonts])].filter(Boolean)
  useEffect(() => { list.forEach(loadFontPreview) }, [list.join()]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return
    const out = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    addEventListener('mousedown', out); addEventListener('keydown', esc)
    return () => { removeEventListener('mousedown', out); removeEventListener('keydown', esc) }
  }, [open])
  return (
    <div className="font-select" ref={ref}>
      <button type="button" className="font-select-btn" aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${value}`} onClick={() => setOpen(!open)} style={{ fontFamily: `"${value}"` }}>{value || 'Escolha'}</button>
      {open && (
        <ul className="font-select-list" role="listbox" aria-label={label}>
          {list.map((f) => (
            <li key={f}><button type="button" role="option" aria-selected={f === value} style={{ fontFamily: `"${f}"` }} onClick={() => { onChange(f); setOpen(false) }}>
              {f}<span className="muted"> Aa Bb 123</span>
            </button></li>
          ))}
        </ul>
      )}
    </div>
  )
}

// Cronômetro m:ss. Enquanto roda, conta até agora (o componente pai atualiza a cada segundo).
export const clock = (ms: number) => { const t = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` }
export const elapsed = (r: { startedAt: string | null; finishedAt: string | null }, now: number) => r.startedAt ? clock((r.finishedAt ? Date.parse(r.finishedAt) : now) - Date.parse(r.startedAt)) : null
export function useNow(on: boolean | undefined) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (!on) return; const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i) }, [on])
  return now
}

// ---------- Player com os controles na identidade do Darkviews ----------
// Espaço pausa ou continua o vídeo em foco: o último que a pessoa usou ou, se nenhum, o primeiro visível na tela.
let lastVideo: HTMLVideoElement | null = null
if (typeof window !== 'undefined') window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return
  const t = e.target as HTMLElement
  if (t.closest('input, textarea, select, [contenteditable="true"]')) return
  const visible = [...document.querySelectorAll<HTMLVideoElement>('video.dv-video')].find((v) => { const r = v.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0 })
  const v = lastVideo?.isConnected ? lastVideo : visible
  if (!v) return
  e.preventDefault()
  if (v.paused) v.play().catch(() => {}); else v.pause()
})

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

// Barra de controles de um <video> (sem os controles nativos). Fica fora do quadro, para não cobrir legenda e enunciados.
export function VideoControls({ videoRef }: { videoRef: React.RefObject<HTMLVideoElement> }) {
  const [, redraw] = useState(0)
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.classList.add('dv-video')
    const up = () => redraw((n) => n + 1)
    const mine = () => { lastVideo = v }
    const toggle = () => { lastVideo = v; if (v.paused) v.play().catch(() => {}); else v.pause() }
    const evs = ['play', 'pause', 'timeupdate', 'durationchange', 'volumechange', 'ended'] as const
    evs.forEach((n) => v.addEventListener(n, up)); v.addEventListener('play', mine); v.addEventListener('click', toggle)
    return () => { evs.forEach((n) => v.removeEventListener(n, up)); v.removeEventListener('play', mine); v.removeEventListener('click', toggle) }
  }, [videoRef.current])
  const v = videoRef.current
  const dur = v && Number.isFinite(v.duration) ? v.duration : 0
  const t = v?.currentTime ?? 0
  const act = (fn: (v: HTMLVideoElement) => void) => () => { if (v) { lastVideo = v; fn(v) } }
  return (
    <div className="dv-controls">
      <button type="button" className="icon-btn" aria-label={v?.paused === false ? 'Pausar (espaço)' : 'Tocar (espaço)'} onClick={act((x) => (x.paused ? x.play().catch(() => {}) : x.pause()))}>
        <Icon name={v?.paused === false ? 'pausar' : 'tocar'} size={16} filled />
      </button>
      <span className="dv-time">{fmtTime(t)} / {fmtTime(dur)}</span>
      <input type="range" className="dv-seek" aria-label="Posição do vídeo" min={0} max={dur || 0} step={0.1} value={t}
        style={{ ['--p' as string]: `${dur ? (t / dur) * 100 : 0}%` }} onChange={(e) => { if (v) { lastVideo = v; v.currentTime = Number(e.target.value) } }} />
      <button type="button" className="icon-btn dv-mute" aria-label={v?.muted ? 'Ligar o som' : 'Tirar o som'} onClick={act((x) => { x.muted = !x.muted })}>{v?.muted ? 'Sem som' : 'Som'}</button>
      <button type="button" className="icon-btn" aria-label="Tela cheia" onClick={act((x) => { const el = x.parentElement ?? x; document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.() })}>
        <Icon name="expandir" size={16} />
      </button>
    </div>
  )
}

// Vídeo com os controles do Darkviews embaixo.
export function Player({ src, className = 'player', autoPlay, videoRef, onTimeUpdate }: { src: string; className?: string; autoPlay?: boolean; videoRef?: React.RefObject<HTMLVideoElement>; onTimeUpdate?: (t: number) => void }) {
  const own = useRef<HTMLVideoElement>(null)
  const ref = videoRef ?? own
  return (
    <div className="dv-player">
      <video ref={ref} className={className} preload="metadata" src={src} autoPlay={autoPlay} playsInline onTimeUpdate={onTimeUpdate && ((e) => onTimeUpdate(e.currentTarget.currentTime))} />
      <VideoControls videoRef={ref} />
    </div>
  )
}
