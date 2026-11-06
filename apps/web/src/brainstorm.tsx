import { useEffect, useState, type FormEvent } from 'react'
import type { BrainstormResult } from '@corte/shared'
import { api } from './api'
import { Modal, PageHead } from './ui'

type Row = { id: string; niche: string; notes: string | null; status: 'queued' | 'running' | 'done' | 'failed'; error: string | null; createdAt: string; result: BrainstormResult | null }

// Ideia → Novo vídeo já preenchido (nome, prompt com gancho e tópicos, duração).
function toNewVideo(niche: string, i: BrainstormResult['ideas'][number]) {
  const prompt = [`${i.angle}`, `Gancho: ${i.hook}`, `Tópicos: ${i.outline.join('; ')}`, `Nicho: ${niche}.`].join('\n')
  const q = new URLSearchParams({ nome: i.title, prompt, minutos: String(Math.min(18, Math.max(0.5, i.durationMin))) })
  return `#/novo?${q}`
}

// Aba Brainstorm: escreve o nicho e recebe ideias de vídeo pesquisadas.
export function BrainstormPage() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [open, setOpen] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = () => api<Row[]>('/brainstorms').then(setRows).catch(() => setRows([]))
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!rows?.some((r) => r.status === 'queued' || r.status === 'running')) return
    const t = setTimeout(load, 4000)
    return () => clearTimeout(t)
  }, [rows])
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>
    setBusy(true); setError('')
    try { await api('/brainstorms', { method: 'POST', body: { niche: f.niche, notes: f.notes } }); form.reset(); await load() }
    catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="page">
      <PageHead kicker="Ideias de vídeo para o seu nicho" title="Brainstorm" />
      <form className="panel brainstorm-form" onSubmit={send}>
        <label>Seu nicho<input name="niche" required minLength={2} maxLength={200} placeholder="Ex.: história do futebol brasileiro, finanças para iniciantes, santos católicos" /></label>
        <label>Detalhes <small className="muted">opcional</small><textarea name="notes" rows={2} maxLength={2000} placeholder="Ex.: público jovem, vídeos de 8 a 12 minutos, tom divertido, evitar política" /></label>
        <div className="row wrap"><span className="muted small">O Claude pesquisa o que está em alta e o que esse público procura. Leva alguns minutos.</span><span className="spacer" /><button disabled={busy}>{busy ? 'Enviando…' : 'Trazer ideias'}</button></div>
      </form>
      {error && <p className="notice alert" role="alert">✕ {error}</p>}
      {rows && !rows.length && <p className="panel muted">Nenhum brainstorm ainda.</p>}
      <div className="brainstorm-list">{(rows ?? []).map((r) => (
        <article key={r.id} className={`panel brainstorm-row ${r.status}`}>
          <div>
            <b>{r.niche}</b>
            <small className="muted">{new Date(r.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}{r.result ? ` · ${r.result.ideas.length} ideias` : ''}</small>
          </div>
          <span className="spacer" />
          {(r.status === 'queued' || r.status === 'running') && <span className="pill"><span className="making-dot" /> Pesquisando…</span>}
          {r.status === 'failed' && <><span className="error small" title={r.error ?? ''}>Falhou</span><button type="button" className="link" onClick={() => api(`/brainstorms/${r.id}/retry`, { method: 'POST' }).then(load)}>Tentar de novo</button></>}
          {r.status === 'done' && <button type="button" onClick={() => setOpen(r)}>Ver ideias</button>}
          {r.status !== 'running' && <button type="button" className="link danger" onClick={() => api(`/brainstorms/${r.id}`, { method: 'DELETE' }).then(load)}>Excluir</button>}
        </article>
      ))}</div>
      {open?.result && (
        <Modal open onClose={() => setOpen(null)} kicker="Brainstorm" title={open.niche} wide>
          <div className="analysis">
            <section className="an-block"><h3>Público</h3><p>{open.result.audience}</p></section>
            <section className="an-block"><h3>Em alta agora</h3><ul className="an-list">{open.result.trends.map((t, i) => <li key={i}>{t}</li>)}</ul></section>
            <div className="idea-grid">{open.result.ideas.map((i, k) => (
              <article key={k} className="an-block idea">
                <b className="idea-title">{i.title}</b>
                <p className="idea-hook">“{i.hook}”</p>
                <p>{i.angle}</p>
                <p className="muted small"><b>Por que funciona:</b> {i.why}</p>
                <details><summary>Tópicos · {i.durationMin} min</summary><ol className="an-list">{i.outline.map((o, j) => <li key={j}>{o}</li>)}</ol></details>
                <a className="btn" href={toNewVideo(open.niche, i)} onClick={() => setOpen(null)}>Criar vídeo com esta ideia</a>
              </article>
            ))}</div>
          </div>
        </Modal>
      )}
    </div>
  )
}
