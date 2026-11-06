import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { AnalysisDetails } from '@corte/shared'
import { api } from './api'
import { Icon } from './icons'
import { Modal, PageHead } from './ui'

type Card = { id: string; url: string; platform: string | null; title: string | null; durationS: number | null; status: 'queued' | 'running' | 'done' | 'failed'; stage: string | null; error: string | null; createdAt: string; hasThumb: boolean }
type Full = Card & { details: AnalysisDetails | null }

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const PLATFORM: Record<string, string> = { youtube: 'YouTube', instagram: 'Instagram', kwai: 'Kwai', tiktok: 'TikTok' }

// Aba Análise: cola o link, o sistema analisa o vídeo inteiro e guarda o card; o estilo pode virar um vídeo novo.
export function AnalysesPage() {
  const [rows, setRows] = useState<Card[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = () => api<Card[]>('/analyses').then(setRows).catch(() => setRows([]))
  useEffect(() => { load() }, [])
  // Enquanto alguma análise roda, atualiza a cada 4 s.
  useEffect(() => {
    if (!rows?.some((r) => r.status === 'queued' || r.status === 'running')) return
    const t = setTimeout(load, 4000)
    return () => clearTimeout(t)
  }, [rows])

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const url = String(new FormData(form).get('url') ?? '')
    setBusy(true); setError('')
    try { await api('/analyses', { method: 'POST', body: { url } }); form.reset(); await load() }
    catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="page">
      <PageHead kicker="Aprenda com qualquer vídeo" title="Análise" />
      <form className="analysis-form" onSubmit={send}>
        <input name="url" required maxLength={500} placeholder="Cole o link do vídeo (YouTube, Instagram, TikTok ou Kwai)" aria-label="Link do vídeo" />
        <button disabled={busy}>{busy ? 'Enviando…' : 'Analisar vídeo'}</button>
      </form>
      {error && <p className="notice alert" role="alert">✕ {error}</p>}
      <p className="muted small">A análise traz roteiro, gancho, falas, pausas, destaques, edição, motion, design, transições e dinâmica. Leva alguns minutos; pode sair desta tela.</p>

      {rows && !rows.length && <p className="panel muted">Nenhuma análise ainda. Cole um link acima.</p>}
      <div className="project-grid">{(rows ?? []).map((r) => (
        <article key={r.id} className={`project-card analysis-card ${r.status}`}>
          <button type="button" className="project-thumb" disabled={r.status !== 'done'} onClick={() => setOpen(r.id)} aria-label={`Abrir a análise de ${r.title ?? r.url}`}>
            {r.hasThumb ? <img src={`/api/analyses/${r.id}/thumb`} alt="" loading="lazy" /> : <span className="muted">{r.status === 'failed' ? 'Falhou' : 'Analisando…'}</span>}
            {r.durationS ? <span className="project-dur">{fmt(r.durationS)}</span> : null}
            {(r.status === 'queued' || r.status === 'running') && <span className="analysis-stage"><span className="making-dot" />{r.stage ?? 'Na fila'}</span>}
          </button>
          <div className="project-body">
            <button type="button" className="link analysis-title" disabled={r.status !== 'done'} onClick={() => setOpen(r.id)}>{r.title ?? r.url}</button>
            <div className="project-meta">
              <span className="pill">{PLATFORM[r.platform ?? ''] ?? 'Link'}</span>
              {r.status === 'failed' && <span className="error small" title={r.error ?? ''}>Falhou</span>}
              {r.status === 'failed' && <button type="button" className="link" onClick={() => api(`/analyses/${r.id}/retry`, { method: 'POST' }).then(load)}>Tentar de novo</button>}
              <span className="spacer" />
              {r.status !== 'running' && <button type="button" className="link danger" onClick={() => api(`/analyses/${r.id}`, { method: 'DELETE' }).then(load)}>Excluir</button>}
            </div>
          </div>
        </article>
      ))}</div>
      {open && <AnalysisModal id={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return <section className="an-block"><h3>{title}</h3>{children}</section>
}
const List = ({ items }: { items: string[] }) => <ul className="an-list">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
const Moments = ({ items }: { items: { timeS: number; text: string }[] }) => (
  <ul className="an-moments">{items.map((m, i) => <li key={i}><span className="tc-chip">{fmt(m.timeS)}</span><span>{m.text}</span></li>)}</ul>
)

// Pop-up com a análise organizada; "Utilizar este estilo" abre o Novo vídeo com o estilo já escolhido.
function AnalysisModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [a, setA] = useState<Full | null>(null)
  useEffect(() => { api<Full>(`/analyses/${id}`).then(setA) }, [id])
  const d = a?.details
  return (
    <Modal open onClose={onClose} kicker="Análise do vídeo" title={a?.title ?? 'Carregando…'} wide>
      {d && a && (
        <div className="analysis">
          <div className="an-top">
            {a.hasThumb && <img src={`/api/analyses/${a.id}/thumb`} alt="" />}
            <div className="stack-sm">
              <p>{d.summary}</p>
              <p className="muted small"><b>Público:</b> {d.audience}</p>
              <div className="row wrap">
                <a className="btn" href={`#/novo?analise=${a.id}`} onClick={onClose}>Utilizar este estilo</a>
                <a className="link" href={a.url} target="_blank" rel="noreferrer">Ver o vídeo original</a>
              </div>
            </div>
          </div>
          <div className="an-grid">
            <Block title="Gancho"><p><span className="tc-chip">{fmt(d.hook.timeS)}</span> “{d.hook.text}”</p><p className="muted small">{d.hook.why}</p></Block>
            <Block title="Roteiro"><List items={d.script.structure} /><h4>Técnicas</h4><List items={d.script.techniques} /></Block>
            <Block title="Falas marcantes"><Moments items={d.script.keyLines} /></Block>
            <Block title="Fala, ritmo e pausas"><p><b>Tom:</b> {d.speech.tone}</p><p><b>Ritmo:</b> {d.speech.pace}</p><p><b>Pausas:</b> {d.speech.pauses}</p></Block>
            <Block title="Destaques"><Moments items={d.highlights} /></Block>
            <Block title="Edição"><p><b>{d.editing.cutsPerMinute.toFixed(1)} cortes por minuto.</b> {d.editing.rhythm}</p><List items={d.editing.notes} /></Block>
            <Block title="Motion"><List items={d.motion} /></Block>
            <Block title="Transições"><List items={d.transitions} /></Block>
            <Block title="Design">
              <div className="an-palette">{d.design.palette.map((c) => <span key={c} title={c} style={{ background: c }} />)}</div>
              <p><b>Tipografia:</b> {d.design.typography}</p><List items={d.design.elements} />
            </Block>
            <Block title="Dinâmica"><p>{d.dynamics}</p></Block>
            <Block title="Áudio"><p><b>Música:</b> {d.audio.music}</p><p><b>Efeitos:</b> {d.audio.effects}</p></Block>
            <Block title="Chamada para ação"><p>{d.callToAction}</p></Block>
          </div>
          <Block title="Linha do tempo"><Moments items={d.timeline} /></Block>
          <Block title="Como recriar este estilo"><ol className="an-list">{d.howToRecreate.map((t, i) => <li key={i}>{t}</li>)}</ol></Block>
          <div className="row"><span /><a className="btn" href={`#/novo?analise=${a.id}`} onClick={onClose}><Icon name="novo" size={16} /> Utilizar este estilo</a></div>
        </div>
      )}
    </Modal>
  )
}
