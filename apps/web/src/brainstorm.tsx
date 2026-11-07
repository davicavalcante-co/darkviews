import { useEffect, useState, type FormEvent } from 'react'
import type { BrainstormResult } from '@corte/shared'
import { api } from './api'
import { elapsed, Modal, PageHead, useNow } from './ui'
import { Icon } from './icons'

type Row = { id: string; niche: string; notes: string | null; status: 'queued' | 'running' | 'done' | 'failed'; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; tokens: number | null; result: BrainstormResult | null }

// Ideia → Novo vídeo já preenchido com TUDO da ideia (título, gancho, ângulo, por que funciona, tópicos, público, observações),
// para o roteiro sair fiel a ela. O prompt cabe em 5000 caracteres.
function toNewVideo(b: Row, i: BrainstormResult['ideas'][number], page = '#/novo') {
  const prompt = [
    `Vídeo do Brainstorm do nicho "${b.niche}". Siga esta ideia fielmente.`,
    `Título: ${i.title}`,
    `Gancho (primeiros 5 segundos): ${i.hook}`,
    `Ângulo: ${i.angle}`,
    `Por que funciona: ${i.why}`,
    `Tópicos do roteiro, nesta ordem:\n${i.outline.map((o, k) => `${k + 1}. ${o}`).join('\n')}`,
    b.result?.audience ? `Público: ${b.result.audience}` : '',
    b.notes ? `Observações do nicho: ${b.notes}` : '',
  ].filter(Boolean).join('\n\n').slice(0, 5000)
  const q = new URLSearchParams({ nome: i.title.slice(0, 120), prompt, minutos: String(Math.min(60, Math.max(0.5, i.durationMin))) })
  return `${page}?${q}`
}

// Aba Brainstorm: escreve o nicho e recebe ideias de vídeo pesquisadas.
export function BrainstormPage() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [open, setOpen] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const now = useNow(rows?.some((r) => r.status === 'running'))
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
    try { await api('/brainstorms', { method: 'POST', body: { niche: f.niche, notes: f.notes } }); form.reset(); setCreating(false); await load() }
    catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="page">
      <PageHead kicker="Ideias de vídeo para o seu nicho" title="Brainstorm">
        <button type="button" onClick={() => { setError(''); setCreating(true) }}>+ Nova ideia</button>
      </PageHead>
      {creating && (
        <Modal open onClose={() => setCreating(false)} kicker="Brainstorm" title="Nova ideia">
          <form className="brainstorm-form" onSubmit={send}>
            <label>Seu nicho<input name="niche" required minLength={2} maxLength={200} autoFocus placeholder="Ex.: história do futebol brasileiro, finanças para iniciantes, santos católicos" /></label>
            <label>Detalhes <small className="muted">opcional</small><textarea name="notes" rows={3} maxLength={2000} placeholder="Ex.: público jovem, vídeos de 8 a 12 minutos, tom divertido, evitar política" /></label>
            <p className="muted small">O Claude pesquisa o que está em alta e o que esse público procura. Leva alguns minutos.</p>
            {error && <p className="notice alert" role="alert">✕ {error}</p>}
            <div className="row"><span className="spacer" /><button disabled={busy}>{busy ? 'Enviando…' : 'Gerar ideias'}</button></div>
          </form>
        </Modal>
      )}
      {rows && !rows.length && <p className="panel muted">Nenhum brainstorm ainda.</p>}
      <div className="brainstorm-list">{(rows ?? []).map((r) => (
        <article key={r.id} className={`panel brainstorm-row ${r.status}`}>
          <div>
            <b>{r.niche}</b>
            <small className="muted">{new Date(r.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}{r.result ? ` · ${r.result.ideas.length} ideias` : ''}</small>
          </div>
          <span className="spacer" />
          {r.startedAt && <span className="muted small" title="Tempo da pesquisa">{elapsed(r, now)}</span>}
          {r.tokens != null && <span className="muted small" title="Tokens do Claude gastos nesta pesquisa">{r.tokens.toLocaleString('pt-BR')} tokens</span>}
          {(r.status === 'queued' || r.status === 'running') && <span className="pill"><span className="making-dot" /> Pesquisando…</span>}
          {r.status === 'failed' && <><span className="error small" title={r.error ?? ''}>Falhou</span><button type="button" className="link" onClick={() => api(`/brainstorms/${r.id}/retry`, { method: 'POST' }).then(load)}>Tentar de novo</button></>}
          {r.status === 'done' && <button type="button" onClick={() => setOpen(r)}>Ver ideias</button>}
          {(r.status === 'queued' || r.status === 'running') && <button type="button" className="link" onClick={() => api(`/brainstorms/${r.id}/stop`, { method: 'POST' }).then(load)}>Parar</button>}
          <button type="button" className="link danger" onClick={() => api(`/brainstorms/${r.id}`, { method: 'DELETE' }).then(load)}>Excluir</button>
        </article>
      ))}</div>
      {open?.result && <IdeasModal b={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

// Ideias em carrossel: duas por vez, com setas (e as setas do teclado). Público e tendências ficam recolhidos em cima.
function IdeasModal({ b, onClose }: { b: Row; onClose: () => void }) {
  const ideas = b.result!.ideas
  const pages = Math.ceil(ideas.length / 2)
  const [page, setPage] = useState(0)
  const go = (d: number) => setPage((x) => (x + d + pages) % pages)
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1) }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [pages])
  return (
    <Modal open onClose={onClose} kicker={`Brainstorm · ${ideas.length} ideias`} title={b.niche} wide>
      <div className="idea-carousel">
        <details className="an-block idea-context">
          <summary>Público e o que está em alta</summary>
          <p>{b.result!.audience}</p>
          <ul className="an-list">{b.result!.trends.map((t, n) => <li key={n}>{t}</li>)}</ul>
        </details>
        <div className="carousel-row">
          <button type="button" className="carousel-arrow" aria-label="Ideias anteriores" onClick={() => go(-1)}><Icon name="anterior" size={20} /></button>
          <div className="carousel-page" aria-live="polite">{ideas.slice(page * 2, page * 2 + 2).map((i, j) => (
            <article key={page * 2 + j} className="an-block idea idea-big">
              <span className="kicker">Ideia {page * 2 + j + 1} de {ideas.length} · {i.durationMin} min</span>
              <h3 className="idea-title">{i.title}</h3>
              <p className="idea-hook">“{i.hook}”</p>
              <p>{i.angle}</p>
              <p className="muted small"><b>Por que funciona:</b> {i.why}</p>
              <details><summary>Tópicos do roteiro ({i.outline.length})</summary><ol className="an-list">{i.outline.map((o, n) => <li key={n}>{o}</li>)}</ol></details>
              <div className="row wrap idea-actions">
                <a className="btn" href={toNewVideo(b, i)} onClick={onClose}>Criar vídeo com esta ideia</a>
                <a className="btn ghost" href={toNewVideo(b, i, '#/falas')} onClick={onClose}>Usar no Vídeo com falas</a>
              </div>
            </article>
          ))}</div>
          <button type="button" className="carousel-arrow" aria-label="Próximas ideias" onClick={() => go(1)}><Icon name="proximo" size={20} /></button>
        </div>
        <div className="carousel-dots" role="tablist" aria-label="Páginas de ideias">{Array.from({ length: pages }, (_, n) => (
          <button key={n} type="button" role="tab" aria-selected={n === page} aria-label={`Ideias ${n * 2 + 1} e ${n * 2 + 2}`} className={n === page ? 'on' : ''} onClick={() => setPage(n)} />
        ))}</div>
      </div>
    </Modal>
  )
}
