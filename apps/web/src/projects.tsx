import { useEffect, useRef, useState } from 'react'
import type { ProgressEvent, ProjectStatus } from '@corte/shared'
import { api } from './api'
import { clock, Modal, PageHead, Player, Section, useNow } from './ui'

const STATUS_LABEL: Record<ProjectStatus, string> = {
  queued: 'Na fila', analyzing: 'Analisando referência', scripting: 'Escrevendo roteiro', script_review: 'Aguardando sua aprovação do roteiro', talking_head: 'Aguardando sua escolha: pessoa falando', media: 'Buscando imagens', image_review: 'Aguardando sua aprovação das imagens', cut_review: 'Aguardando sua aprovação dos cortes', quote_review: 'Aguardando os cortes das falas',
  rendering: 'Criando vídeo', editing: 'Em edição', in_approval: 'Aguardando aprovação', approved: 'Aprovado', failed: 'Falhou',
}
const STAGES = ['Na fila', 'Analisando referência', 'Escrevendo roteiro', 'Buscando imagens', 'Gerando áudio', 'Criando vídeo', 'Pronto']

function stageIndex(e: ProgressEvent) {
  switch (e.status) {
    case 'queued': return 0
    case 'analyzing': return 1
    case 'scripting': return 2
    case 'media': return e.job?.type === 'voice' ? 4 : 3
    case 'image_review': case 'cut_review': case 'quote_review': return 3
    case 'script_review': return 2
    case 'talking_head': return 1
    case 'rendering': return 5
    case 'failed': return -1
    default: return 6
  }
}

const PROFILE_LABEL: Record<string, string> = {
  pacing: 'Ritmo', cutsPerMinute: 'Cortes por minuto', transitions: 'Transições', shotTypes: 'Enquadramentos', composition: 'Composição', setting: 'Cenários',
  imagery: 'Imagens e vídeos', textOnScreen: 'Textos na tela', captionStyle: 'Legendas', palette: 'Cores', structure: 'Estrutura', tone: 'Tom da narração',
  audio: 'Áudio', talkingHead: 'Pessoa falando', recommendations: 'Recomendações', notes: 'Observações',
}
type TalkingHeadInfo = { present: boolean; segments: { startS: number; endS: number; description: string }[] }
const talkingText = (t: TalkingHeadInfo) => (t.present ? t.segments.map((s) => `${fmtDuration(s.startS)}–${fmtDuration(s.endS)}: ${s.description}`).join(' · ') || 'Sim' : 'Não')

const fmtDuration = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

type ProjectRow = { id: string; name: string; status: ProjectStatus; targetDurationS: number; createdAt: string; owner: { name: string }; video: { version: number; durationS: number } | null }

type ListProps = {
  isAdmin: boolean
  title?: string
  statuses?: ProjectStatus[] // só os projetos nestes status (abas Edição e Aprovação)
  href?: (id: string) => string
  empty?: string
}

export function ProjectList({ isAdmin, title = 'Projetos', statuses, href = (id) => `#/projeto/${id}`, empty = 'Nenhum projeto ainda.' }: ListProps) {
  const [all, setRows] = useState<ProjectRow[] | null>(null)
  const rows = all && (statuses ? all.filter((p) => statuses.includes(p.status)) : all)
  const load = () => api<ProjectRow[]>('/projects').then(setRows)
  useEffect(() => { load() }, [])

  const [toDelete, setToDelete] = useState<ProjectRow | null>(null)
  const [delBusy, setDelBusy] = useState(false)
  const [delError, setDelError] = useState('')
  async function remove() {
    setDelBusy(true); setDelError('')
    try { await api(`/projects/${toDelete!.id}`, { method: 'DELETE' }); setToDelete(null); load() }
    catch (e) { setDelError((e as Error).message) } finally { setDelBusy(false) }
  }

  if (!rows) return null
  return (
    <div className="page">
      <PageHead kicker={`${rows.length} ${rows.length === 1 ? 'vídeo' : 'vídeos'}`} title={title}>
        <a className="btn" href="#/novo">+ Novo vídeo</a>
      </PageHead>
      <div>
        {rows.length === 0 ? <p className="panel muted">{empty}</p> : (
          <div className="project-grid">{rows.map((p) => (
            <article key={p.id} className={`project-card ${p.status}`}>
              <a href={href(p.id)} className="project-thumb" aria-label={`Abrir ${p.name}`}>
                {p.video ? <img src={`/api/projects/${p.id}/frame?t=2&v=${p.video.version}`} alt="" loading="lazy" /> : <span className="muted">{STATUS_LABEL[p.status]}</span>}
                <span className="project-dur">{fmtDuration(p.video?.durationS ?? p.targetDurationS)}</span>
              </a>
              <div className="project-body">
                <a href={href(p.id)} className="project-name">{p.name}</a>
                <div className="project-meta">
                  <span className="pill"><span className={`dot ${p.status === 'approved' ? 'on' : p.status === 'failed' ? 'off' : ''}`} />{STATUS_LABEL[p.status]}</span>
                  <span className="muted">{new Date(p.createdAt).toLocaleDateString('pt-BR')}{isAdmin ? ` · ${p.owner.name}` : ''}</span>
                </div>
              </div>
              {(isAdmin || p.status !== 'approved') && <button className="link project-del" onClick={() => { setDelError(''); setToDelete(p) }} aria-label={`Excluir ${p.name}`}>Excluir</button>}
            </article>))}
          </div>
        )}
      </div>
      {toDelete && (
        <Modal open onClose={() => !delBusy && setToDelete(null)} kicker="Excluir vídeo" title={toDelete.name}>
          <p>Isso apaga o vídeo e tudo o que ele usou: imagens, vídeos enviados, narração, cortes e miniaturas. <b>Não dá para desfazer.</b></p>
          {delError && <p className="notice alert" role="alert">✕ {delError}</p>}
          <footer className="modal-actions">
            <span className="spacer" />
            <button type="button" className="ghost-btn" disabled={delBusy} onClick={() => setToDelete(null)}>Cancelar</button>
            <button type="button" className="danger" disabled={delBusy} onClick={remove}>{delBusy ? 'Excluindo…' : 'Excluir de vez'}</button>
          </footer>
        </Modal>
      )}
    </div>
  )
}

type SceneRow = { index: number; startS: number; endS: number; narration: string | null; onScreenText: string | null; assetId: string | null; searchQuery: string | null; transition: string | null }
type Detail = {
  name: string
  reviewUntil: string | null
  reference: { styleProfile: Record<string, unknown> | null } | null
  script: { version: number; body: string; scenes: SceneRow[] } | null
  metadata: { title?: string; description?: string; keywords?: string }
  video: { version: number; durationS: number } | null
}

function sceneMedia(s: SceneRow) {
  if (s.assetId) return 'Imagem do cliente'
  const m = s.searchQuery ? JSON.parse(s.searchQuery) : null
  if (m?.type === 'stock') return `Banco (${m.kind === 'video' ? 'vídeo' : 'foto'}): ${m.queries.join(' · ')}`
  if (m?.type === 'text_card') return `Quadro de texto: ${m.text}`
  return '—'
}

type ReviewScene = { index: number; narration: string | null; assetId: string; kind: 'image' | 'video'; bank: string; credit: string | null; copyright?: boolean }

// Aprovação antecipada das imagens: tudo começa aprovado; "Trocar" pede uma nova opção só para aquela cena.
// A referência tem uma pessoa falando para a câmera: o cliente escolhe como fazer esses trechos.
function TalkingHead({ id }: { id: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function send(body: unknown) {
    setBusy(true); setError('')
    try { await api(`/projects/${id}/talking-head`, { method: 'POST', body }) } catch (e) { setError((e as Error).message); setBusy(false) }
  }
  return (
    <div className="stack">
      <p>O vídeo de referência tem trechos com <b>uma pessoa falando para a câmera</b>. Como quer fazer esses trechos?</p>
      <div className="cards">
        <div className="panel">
          <span className="panel-title">1. Vídeo de banco</span>
          <p className="muted">Usamos um vídeo de banco de uma pessoa falando, com a sua narração e a legenda por cima.</p>
          <button type="button" disabled={busy} onClick={() => send({ choice: 'stock' })}>Usar vídeo de banco</button>
        </div>
        <div className="panel">
          <span className="panel-title">2. Seu vídeo</span>
          <p className="muted">Envie um vídeo seu falando. Ele entra sem som, com a narração e a legenda passando.</p>
          <label className={`btn${busy ? ' disabled' : ''}`}>
            {busy ? 'Enviando…' : 'Enviar meu vídeo'}
            <input type="file" accept="video/mp4,video/quicktime,video/webm" hidden disabled={busy} onChange={(e) => {
              const f = e.target.files?.[0]; e.target.value = ''
              if (!f) return
              const body = new FormData(); body.append('video', f); send(body)
            }} />
          </label>
        </div>
      </div>
      {error && <p className="notice alert" role="alert">✕ {error}</p>}
    </div>
  )
}

// Roteiro pronto: a pessoa lê cena por cena e aprova, ajusta as falas à mão ou pede ao Claude para refazer com dicas.
// Prazo da aprovação (10 min por rodada). No fim, onExpire roda uma vez (o servidor também aprova se a tela estiver fechada).
function ReviewClock({ until, onExpire }: { until: number | null; onExpire?: () => void }) {
  const now = useNow(until !== null)
  const fired = useRef(false)
  useEffect(() => { if (until !== null && now >= until && !fired.current) { fired.current = true; onExpire?.() } }, [now, until])
  if (until === null) return null
  return (
    <span className={`review-clock${until - now < 60_000 ? ' late' : ''}`} role="timer" title="Sem resposta até o fim do prazo, aprova sozinho e segue">
      {until > now ? <>Aprovação automática em <b>{clock(until - now)}</b></> : 'Tempo esgotado: aprovando…'}
    </span>
  )
}

function ScriptReview({ id, detail }: { id: string; detail: Detail }) {
  const [scenes, setScenes] = useState(detail.script!.scenes.map((s) => ({ index: s.index, narration: s.narration ?? '', onScreenText: s.onScreenText ?? '' })))
  const [editing, setEditing] = useState(false)
  const [redo, setRedo] = useState(false)
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const changed = scenes.some((s, i) => s.narration !== (detail.script!.scenes[i].narration ?? '') || s.onScreenText !== (detail.script!.scenes[i].onScreenText ?? ''))
  async function send(action: 'approve' | 'redo') {
    setBusy(true); setError('')
    try { await api(`/projects/${id}/script-review`, { method: 'POST', body: { action, hint: action === 'redo' ? hint : undefined, scenes: changed ? scenes : undefined } }) }
    catch (e) { setError((e as Error).message); setBusy(false) }
  }
  const set = (i: number, patch: Partial<(typeof scenes)[number]>) => setScenes((cur) => cur.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  return (
    <div className="script-review">
      <div className="review-head">
        <div>
          <h3>{detail.metadata.title || 'Roteiro'}</h3>
          <p className="muted">Leia o roteiro. Se estiver bom, aprove e o vídeo segue para as imagens. Dá para ajustar as falas aqui mesmo ou pedir ao Claude para refazer.</p>
        </div>
        <div className="row wrap">
          {/* Tempo esgotado com a tela aberta: aprova levando as falas que a pessoa já editou */}
          <ReviewClock until={detail.reviewUntil ? Date.parse(detail.reviewUntil) : null} onExpire={() => { if (!busy) send('approve') }} />
          <button type="button" className="ghost-btn" disabled={busy} onClick={() => { setRedo(!redo); setEditing(false) }}>Refazer com dicas</button>
          <button type="button" className="ghost-btn" disabled={busy} onClick={() => { setEditing(!editing); setRedo(false) }}>{editing ? 'Fechar edição' : 'Editar falas'}</button>
          <button type="button" disabled={busy} onClick={() => send('approve')}>{busy ? 'Enviando…' : changed ? 'Salvar e aprovar' : 'Aprovar roteiro'}</button>
        </div>
      </div>
      {redo && (
        <div className="redo-box">
          <label>Como você quer o roteiro novo?
            <textarea rows={3} maxLength={2000} value={hint} placeholder="Ex.: comece com uma pergunta, deixe mais curto, fale mais sobre a infância dele, tom mais divertido" onChange={(e) => setHint(e.target.value)} />
          </label>
          <button type="button" disabled={busy || !hint.trim()} onClick={() => send('redo')}>Refazer o roteiro</button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <ol className="script-scenes">
        {scenes.map((s, i) => (
          <li key={s.index}>
            <span className="tc-chip">{fmtDuration(detail.script!.scenes[i].startS)}</span>
            {editing ? (
              <div className="stack-sm">
                <textarea rows={2} value={s.narration} aria-label={`Fala da cena ${i + 1}`} onChange={(e) => set(i, { narration: e.target.value })} />
                <input value={s.onScreenText} maxLength={120} placeholder="Texto na tela (opcional)" aria-label={`Texto na tela da cena ${i + 1}`} onChange={(e) => set(i, { onScreenText: e.target.value })} />
              </div>
            ) : (
              <div>
                {s.onScreenText && <b className="scene-title">{s.onScreenText}</b>}
                <p>{s.narration || <em className="muted">sem fala</em>}</p>
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

// Vídeo com falas: para cada fala exata do roteiro, a pessoa envia o corte (com o áudio original) ou deixa o locutor falar.
function QuoteReview({ id }: { id: string }) {
  type Q = { index: number; text: string; source: string; clipId: string | null; narrator: boolean }
  const [data, setData] = useState<{ reviewUntil: string | null; footage: number; stages: { kind: 'narrador' | 'fala'; first: number; last: number; durationS: number }[]; quotes: Q[] } | null>(null)
  const [busy, setBusy] = useState<number | 'all' | null>(null)
  const [error, setError] = useState('')
  const load = () => api<NonNullable<typeof data>>(`/projects/${id}/quote-review`).then(setData).catch((e) => setError(e.message))
  useEffect(() => { load() }, [id])
  if (!data) return error ? <p className="error">{error}</p> : null
  async function act(key: number | 'all', fn: () => Promise<unknown>) {
    setBusy(key); setError('')
    try { await fn(); if (key !== 'all') await load() } catch (e) { setError((e as Error).message) } finally { if (key !== 'all') setBusy(null) }
  }
  const upload = (q: Q, f: File | undefined) => f && act(q.index, () => { const body = new FormData(); body.append('video', f); return api(`/projects/${id}/quote-review/${q.index}`, { method: 'POST', body }) })
  const pending = data.quotes.filter((q) => !q.clipId && !q.narrator).length
  return (
    <div className="review">
      <div className="review-head">
        <div>
          <h3>Envie o corte de cada fala</h3>
          <p className="muted">O corte entra com a imagem e o áudio originais, 3 s depois do locutor anunciar. Sem corte, o locutor fala a frase e ela aparece na tela.</p>
        </div>
        <button type="button" disabled={busy !== null || !data.footage} title={data.footage ? '' : 'Envie o vídeo longo primeiro'} onClick={() => { if (pending && !confirm(`${pending} ${pending === 1 ? 'fala está' : 'falas estão'} sem corte e vão com o locutor. Continuar mesmo assim?`)) return; act('all', () => api(`/projects/${id}/quote-review`, { method: 'POST' })) }}>
          {busy === 'all' ? 'Enviando…' : pending ? `Continuar (${pending} com o locutor)` : 'Continuar'}
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <article className="panel quote-row">
        <div className="quote-text"><b>Vídeo longo (contexto)</b><small className="muted">Os cortes dele passam enquanto o narrador fala. {data.footage ? `${data.footage} enviado${data.footage > 1 ? 's' : ''}.` : 'Obrigatório para continuar.'} Sem prazo: o vídeo só segue quando você clicar em Continuar.</small></div>
        <div className="row wrap"><span className="spacer" />
          <label className="btn ghost">{busy === -1 ? 'Enviando…' : data.footage ? 'Enviar outro' : 'Enviar vídeo longo'}
            <input type="file" hidden accept="video/mp4,video/quicktime,video/webm" disabled={busy !== null} onChange={(e) => {
              const f = e.target.files?.[0]; e.target.value = ''
              if (f) act(-1, () => { const body = new FormData(); body.append('footage', f); return api(`/projects/${id}/quote-review/footage`, { method: 'POST', body }) })
            }} />
          </label>
        </div>
      </article>
      <div className="notice">
        <p><b>{data.stages.length} etapas</b> · cerca de {clock(data.stages.reduce((n, st) => n + st.durationS, 0) * 1000)} no total (pelo roteiro; a fala real ajusta).</p>
        <ol className="stage-list">{data.stages.map((st, k) => {
          const q = st.kind === 'fala' ? data.quotes.find((x) => x.index === st.first) : null
          return <li key={k}>Etapa {k + 1} · {q ? <>Fala: “{q.text}”</> : <>Narrador (cenas {st.first + 1}{st.last > st.first ? `–${st.last + 1}` : ''})</>} · ~{clock(st.durationS * 1000)}</li>
        })}</ol>
      </div>
      {!data.quotes.length && <p className="muted">O roteiro não trouxe falas exatas. Clique em Continuar.</p>}
      <div className="stack-sm">{data.quotes.map((q) => (
        <article key={q.index} className="panel quote-row">
          <div className="quote-text"><b>“{q.text}”</b><small className="muted">{q.source} · cena {q.index + 1}</small></div>
          {q.clipId && <video className="quote-clip" src={`/api/projects/${id}/assets/${q.clipId}`} controls preload="metadata" />}
          <div className="row wrap">
            <span className="muted small">{q.clipId ? 'Corte enviado' : q.narrator ? 'Vai com o locutor' : 'Falta o corte'}</span>
            <span className="spacer" />
            <label className="btn ghost">{busy === q.index ? 'Enviando…' : q.clipId ? 'Trocar corte' : 'Enviar corte'}
              <input type="file" hidden accept="video/mp4,video/quicktime,video/webm" disabled={busy !== null} onChange={(e) => { upload(q, e.target.files?.[0]); e.target.value = '' }} />
            </label>
            {!q.narrator && <button type="button" className="ghost-btn" disabled={busy !== null} onClick={() => act(q.index, () => api(`/projects/${id}/quote-review/${q.index}`, { method: 'POST', body: {} }))}>Usar o locutor</button>}
          </div>
        </article>
      ))}</div>
    </div>
  )
}

// Cortes dos vídeos enviados (Só vídeos): reprovados são apagados; com reprovados, a pessoa escolhe repor com cortes novos ou repetir os aprovados.
function CutReview({ id }: { id: string }) {
  const [data, setData] = useState<{ reviewUntil: string | null; pending: { id: string; durationS: number | null }[]; approved: number } | null>(null)
  const [out, setOut] = useState<Set<string>>(new Set())
  const [refill, setRefill] = useState<'new' | 'loop' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { api<NonNullable<typeof data>>(`/projects/${id}/cut-review`).then(setData).catch((e) => setError(e.message)) }, [id])
  if (!data) return error ? <p className="error">{error}</p> : null
  const toggle = (c: string) => setOut((cur) => { const n = new Set(cur); n.has(c) ? n.delete(c) : n.add(c); return n })
  async function send() {
    if (out.size && !refill) return setError('Escolha o que fazer no lugar dos cortes reprovados')
    setBusy(true); setError('')
    try { await api(`/projects/${id}/cut-review`, { method: 'POST', body: { rejected: [...out], refill: refill ?? 'loop' } }) } catch (e) { setError((e as Error).message); setBusy(false) }
  }
  return (
    <div className="review">
      <div className="review-head">
        <div>
          <h3>Aprove os cortes dos seus vídeos</h3>
          <p className="muted">Todos começam aprovados. Clique em <b>Reprovar</b> nos que não servem: eles são apagados do sistema.{data.approved ? ` ${data.approved} cortes já aprovados antes.` : ''}</p>
        </div>
        <ReviewClock until={data.reviewUntil ? Date.parse(data.reviewUntil) : null} />
        <button type="button" disabled={busy} onClick={send}>{busy ? 'Enviando…' : out.size ? `Apagar ${out.size} e continuar` : 'Aprovar todos e continuar'}</button>
      </div>
      {out.size > 0 && (
        <div className="notice" role="group" aria-label="No lugar dos reprovados">
          <p>No lugar dos {out.size} cortes reprovados:</p>
          <div className="row wrap">
            <label className="check"><input type="radio" name="refill" checked={refill === 'new'} onChange={() => setRefill('new')} /><span>Fazer novos cortes para compensar</span></label>
            <label className="check"><input type="radio" name="refill" checked={refill === 'loop'} onChange={() => setRefill('loop')} /><span>Repetir os aprovados em loop</span></label>
          </div>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="review-grid">{data.pending.map((c, k) => (
        <article key={c.id} className={`review-card${out.has(c.id) ? ' rejected' : ''}`}>
          <div className="review-media">
            <video src={`/api/projects/${id}/assets/${c.id}#t=0.5`} muted loop playsInline preload="metadata"
              onMouseEnter={(e) => e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => e.currentTarget.pause()} />
            <span className="review-tag">Corte {k + 1}{c.durationS ? ` · ${c.durationS.toFixed(1)} s` : ''}</span>
          </div>
          <div className="row"><span className="spacer" />
            <button type="button" className={out.has(c.id) ? 'ghost-btn on' : 'ghost-btn'} aria-pressed={out.has(c.id)} onClick={() => toggle(c.id)}>{out.has(c.id) ? 'Vai apagar' : 'Reprovar'}</button>
          </div>
        </article>
      ))}</div>
    </div>
  )
}

function ImageReview({ id }: { id: string }) {
  const [scenes, setScenes] = useState<ReviewScene[] | null>(null)
  const [round, setRound] = useState(1)
  const [until, setUntil] = useState<number | null>(null)
  const [swap, setSwap] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = () => api<{ scenes: ReviewScene[]; round: number; reviewUntil: string | null }>(`/projects/${id}/review`).then((r) => { setScenes(r.scenes); setRound(r.round); setUntil(r.reviewUntil ? Date.parse(r.reviewUntil) : null) }).catch((e) => setError(e.message))
  useEffect(() => { load() }, [id])
  // 2ª rodada: a pessoa pode enviar a própria foto para a cena; ela já entra aprovada e sai desta lista.
  async function upload(index: number, f: File | undefined) {
    if (!f) return
    setBusy(true); setError('')
    const body = new FormData(); body.append('images', f)
    try { await api(`/projects/${id}/review/${index}/upload`, { method: 'POST', body }); setSwap((cur) => { const n = new Set(cur); n.delete(index); return n }); await load() }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  if (!scenes) return error ? <p className="error">{error}</p> : null
  const toggle = (i: number) => setSwap((cur) => { const n = new Set(cur); n.has(i) ? n.delete(i) : n.add(i); return n })
  async function send() {
    setBusy(true); setError('')
    try { await api(`/projects/${id}/review`, { method: 'POST', body: { rejected: [...swap] } }) } catch (e) { setError((e as Error).message); setBusy(false) }
  }
  return (
    <div className="review">
      <div className="review-head">
        <div>
          <h3>Aprove as imagens antes da narração</h3>
          <p className="muted">{round > 1
            ? <>Estas são as novas opções para as cenas que você trocou ({scenes.length}). Se nenhuma servir, clique em <b>Enviar minha foto</b> na cena.</>
            : <>Todas começam aprovadas. Clique em <b>Trocar</b> nas que não servem: o sistema busca outra opção só para essas cenas e mostra de novo.</>}</p>
        </div>
        <ReviewClock until={until} />
        <button type="button" disabled={busy} onClick={send}>
          {busy ? 'Enviando…' : !scenes.length ? 'Tudo aprovado · continuar' : swap.size ? `Trocar ${swap.size} e aprovar o resto` : 'Aprovar todas e continuar'}
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="review-grid">
        {scenes.map((s) => (
          <article key={s.index} className={`review-card${swap.has(s.index) ? ' rejected' : ''}`}>
            <div className="review-media">
              {s.kind === 'video'
                ? <video src={`/api/projects/${id}/assets/${s.assetId}`} muted loop playsInline autoPlay preload="metadata" />
                : <img src={`/api/projects/${id}/assets/${s.assetId}`} alt={s.narration ?? ''} loading="lazy" />}
              <span className="review-tag">Cena {s.index + 1} · {s.kind === 'video' ? 'vídeo' : 'foto'}</span>
            </div>
            <p className="review-text">{s.narration}</p>
            <div className="row">
              <small className="muted">{s.bank}</small>
              {s.copyright && <small className="copyright" title={s.credit ?? ""}>Tem direitos autorais do dono</small>}
              {round > 1 && (
                <label className="btn ghost upload-photo">Enviar minha foto
                  <input type="file" hidden accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(e) => { upload(s.index, e.target.files?.[0]); e.target.value = '' }} />
                </label>
              )}
              <button type="button" className={swap.has(s.index) ? 'ghost-btn on' : 'ghost-btn'} aria-pressed={swap.has(s.index)} onClick={() => toggle(s.index)}>
                {swap.has(s.index) ? 'Vai trocar' : 'Trocar'}
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

type Timing = { stages: { type: string; status: string; elapsedS: number; estimateS: number }[]; elapsedS: number; estimateS: number }
const STAGE_NAME: Record<string, string> = { ingest: 'Referência', analyze: 'Análise', script: 'Roteiro', media: 'Imagens', montage: 'Montagem dos cortes', voice: 'Narração', render: 'Vídeo e áudio final' }
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

// Cronômetro da criação: tempo de cada etapa e estimativa total. Passou do previsto: pergunta se continua.
function Timer({ id, running }: { id: string; running: boolean }) {
  const [t, setT] = useState<Timing | null>(null)
  const [tick, setTick] = useState(0)
  const [limit, setLimit] = useState(1) // "continuar esperando" dá mais 50% de prazo
  const [stopping, setStopping] = useState(false)
  useEffect(() => { api<Timing>(`/projects/${id}/timing`).then(setT).catch(() => {}) }, [id, Math.floor(tick / 5)])
  useEffect(() => { if (!running) return; const i = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(i) }, [running])
  if (!t) return null
  const live = (tick % 5) // segundos desde a última leitura do servidor
  const runningStage = t.stages.find((s) => s.status === 'running')
  const elapsed = t.elapsedS + (running && runningStage ? live : 0)
  const late = running && elapsed > t.estimateS * limit
  return (
    <div className="timer">
      <div className="timer-total">
        <span><b>{mmss(elapsed)}</b><small>decorrido</small></span>
        <span><b>{mmss(t.estimateS)}</b><small>previsto no total</small></span>
        <span><b>{elapsed < t.estimateS ? mmss(t.estimateS - elapsed) : '—'}</b><small>falta</small></span>
      </div>
      <ol className="timer-stages">{t.stages.map((s) => (
        <li key={s.type} className={s.status}>
          <span>{STAGE_NAME[s.type] ?? s.type}</span>
          <span className="tc">{s.status === 'pending' ? `~${mmss(s.estimateS)}` : mmss(s.elapsedS + (s.status === 'running' ? live : 0))}</span>
        </li>
      ))}</ol>
      {late && (
        <div className="notice warn-box" role="alert">
          <p>Está levando mais do que o previsto ({mmss(elapsed)} de {mmss(t.estimateS)}). Quer continuar esperando?</p>
          <div className="row wrap">
            <button type="button" onClick={() => setLimit(limit + 0.5)}>Continuar esperando</button>
            <button type="button" className="ghost-btn" disabled={stopping} onClick={async () => { setStopping(true); await api(`/projects/${id}/cancel`, { method: 'POST' }).catch(() => {}); setStopping(false) }}>
              {stopping ? 'Parando…' : 'Parar a criação'}
            </button>
          </div>
          <small className="muted">Parar termina a etapa atual e não segue para as próximas. Depois dá para tentar de novo.</small>
        </div>
      )}
    </div>
  )
}

// Saída para vídeo que falhou: explica em uma frase e repete só a etapa que deu erro.
function Retry({ id, error, hasVideo }: { id: string; error: string | null; hasVideo: boolean }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [confirm, setConfirm] = useState(false)
  async function drop() {
    setBusy(true); setMsg('')
    try {
      if (hasVideo) { await api(`/projects/${id}/discard`, { method: 'POST' }); location.hash = `#/editar/${id}` }
      else { await api(`/projects/${id}`, { method: 'DELETE' }); location.hash = '#/projetos' }
    } catch (e) { setMsg((e as Error).message); setBusy(false) }
  }
  return (
    <div className="retry">
      <p className="alert" role="alert"><b>Esta etapa falhou.</b> {error ? `Motivo: ${error}` : 'Abra Admin → Logs para ver o motivo.'}</p>
      <p className="muted">Tentar de novo repete só a etapa que falhou; o que já ficou pronto (análise, roteiro, imagens) é aproveitado.</p>
      <div className="row">
        <a className="link" href={`#/editar/${id}`}>Ajustar antes (ex.: trocar a fonte da legenda)</a>
        <button type="button" disabled={busy} onClick={async () => {
          setBusy(true); setMsg('')
          try { await api(`/projects/${id}/retry`, { method: 'POST' }) } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
        }}>{busy ? 'Enviando…' : 'Tentar de novo'}</button>
        <button type="button" className="ghost-btn" disabled={busy} onClick={() => setConfirm(true)}>{hasVideo ? 'Descartar esta tentativa' : 'Excluir este vídeo'}</button>
      </div>
      {msg && <p className="error" role="alert">{msg}</p>}
      <Modal open={confirm} onClose={() => setConfirm(false)} title={hasVideo ? 'Descartar esta tentativa?' : 'Excluir este vídeo?'}>
        <p>{hasVideo ? 'O vídeo volta para a última versão pronta. O que esta tentativa fez é deixado de lado.' : 'O vídeo e tudo o que ele usou são apagados. Não dá para desfazer.'}</p>
        <footer className="modal-actions"><span className="spacer" />
          <button type="button" className="ghost-btn" onClick={() => setConfirm(false)}>Cancelar</button>
          <button type="button" disabled={busy} onClick={drop}>{hasVideo ? 'Descartar' : 'Excluir'}</button>
        </footer>
      </Modal>
    </div>
  )
}

// Em criação (qualquer método, inclusive esperando aprovação): dá para cancelar. Para no próximo ponto seguro.
const CREATING = ['queued', 'analyzing', 'scripting', 'script_review', 'talking_head', 'media', 'image_review', 'cut_review', 'quote_review', 'rendering']
function CancelVideo({ id }: { id: string }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <button type="button" className="ghost-btn" onClick={() => setOpen(true)}>Cancelar vídeo</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Cancelar este vídeo?">
        <p>A criação para agora (no máximo ao fim da cena em andamento). O que já ficou pronto é guardado: depois dá para <b>Tentar de novo</b> de onde parou ou <b>Excluir</b>.</p>
        <footer className="modal-actions"><span className="spacer" />
          <button type="button" className="ghost-btn" onClick={() => setOpen(false)}>Voltar</button>
          <button type="button" className="danger" disabled={busy} onClick={async () => { setBusy(true); await api(`/projects/${id}/cancel`, { method: 'POST' }).catch(() => {}); setBusy(false); setOpen(false) }}>{busy ? 'Cancelando…' : 'Cancelar vídeo'}</button>
        </footer>
      </Modal>
    </>
  )
}

export function Progress({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [ev, setEv] = useState<ProgressEvent | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    const es = new EventSource(`/api/projects/${id}/events`)
    es.onmessage = (m) => setEv(JSON.parse(m.data))
    return () => es.close()
  }, [id])
  // Recarrega o detalhe quando o projeto muda de etapa (perfil e roteiro aparecem ao final de cada uma).
  useEffect(() => { api<Detail>(`/projects/${id}`).then(setDetail, () => setMissing(true)) }, [id, ev?.status])
  const name = detail?.name ?? ''
  // Vídeo pronto: a tela de andamento dá lugar ao editor (baixar, editar e aprovar ficam lá).
  const ready = !!ev && ['editing', 'in_approval', 'approved'].includes(ev.status) && !['queued', 'running', 'paused'].includes(ev.job?.status ?? '')
  useEffect(() => { if (ready) location.replace(`#/editar/${id}`) }, [ready, id])

  if (missing) return <p>Projeto não encontrado. <a href="#/projetos">Voltar</a></p>
  if (!ev) return null
  const current = stageIndex(ev)
  const waiting = ev.job?.status === 'queued'
  return (
    <div className="page">
      <PageHead back={{ href: '#/projetos', label: 'Projetos' }} kicker={STATUS_LABEL[ev.status]} title={name}>
        {CREATING.includes(ev.status) && <CancelVideo id={id} />}
        {detail?.video && <>
          <a className="btn ghost" href={`/api/projects/${id}/video?download=1`}>Baixar MP4</a>
          <a className="btn ghost" href={`#/editar/${id}`}>Editar</a>
          <a className="btn" href={`#/aprovar/${id}`}>{ev.status === 'approved' ? 'Cortes' : 'Aprovar'}</a>
        </>}
      </PageHead>

      <Section idx={1} title="Andamento">
        <div className="cards">
          <div className="panel narrow">
            {current === -1 ? (
              <Retry id={id} error={ev.job?.error ?? null} hasVideo={!!detail?.video} />
            ) : (
              <>
                <ol className="stages">{STAGES.map((s, i) => (
                  <li key={s} className={i < current ? 'done' : i === current ? 'now' : ''}>{s}</li>
                ))}</ol>
                <Timer id={id} running={['queued', 'running', 'paused'].includes(ev.job?.status ?? '')} />
                <progress max={100} value={ev.job?.progress ?? 0} aria-label="Progresso da etapa" />
                <p className="muted">
                  {ev.job?.stage ?? STAGES[current]} · {ev.job?.progress ?? 0}%
                  {ev.job?.etaS ? ` · cerca de ${fmtDuration(ev.job.etaS)} restantes` : waiting ? ' · aguardando na fila' : ''}
                </p>
              </>
            )}
            {ev.status === 'script_review' && <p className="warn" role="status">Roteiro pronto: leia abaixo e aprove, edite ou peça para refazer.</p>}
            {ev.status === 'image_review' && <p className="warn" role="status">Escolha das imagens pronta: aprove abaixo para seguir para a narração.</p>}
            {ev.job?.status === 'paused' && <p className="warn" role="status">Pausado: {(ev.job.stage ?? '').replace(/\.$/, '')}. Volta sozinho quando o Claude estiver disponível.</p>}
          </div>
          {detail?.video && (
            <div className="panel wide">
              {/* Criando outra versão: deixa claro que este é o vídeo anterior, não o novo. */}
              {['queued', 'running', 'paused'].includes(ev.job?.status ?? '') ? (
                <div className="old-video">
                  <Player src={`/api/projects/${id}/video?v=${detail.video.version}`} />
                  <div className="making" role="status"><span className="making-dot" />Nova versão em andamento · este é o vídeo anterior</div>
                </div>
              ) : <Player src={`/api/projects/${id}/video?v=${detail.video.version}`} />}
              <p className="muted">Versão {detail.video.version}{['queued', 'running', 'paused'].includes(ev.job?.status ?? '') ? ' (anterior)' : ''} · {fmtDuration(detail.video.durationS)}</p>
            </div>
          )}
        </div>
      </Section>

      {ev.status === 'talking_head' && <Section idx={1} title="Pessoa falando"><TalkingHead id={id} /></Section>}
      {ev.status === 'script_review' && detail?.script && <Section idx={1} title="Aprovar roteiro"><ScriptReview key={detail.script.version} id={id} detail={detail} /></Section>}
      {ev.status === 'image_review' && <Section idx={1} title="Aprovar imagens"><ImageReview key={ev.job?.type ?? ''} id={id} /></Section>}
      {ev.status === 'cut_review' && <Section idx={1} title="Aprovar cortes"><CutReview key={ev.job?.type ?? ''} id={id} /></Section>}
      {ev.status === 'quote_review' && <Section idx={1} title="Falas do vídeo"><QuoteReview id={id} /></Section>}

      {(detail?.script || detail?.reference?.styleProfile) && (
        <Section idx={2} title="Roteiro">
          <div className="cards">
            {detail?.script && (
              <div className="panel wide">
                <span className="panel-title">Título e descrição</span>
                <h3>{detail.metadata.title}</h3>
                <p className="pre">{detail.metadata.description}</p>
                <p className="muted">Palavras-chave: {detail.metadata.keywords}</p>
                <details><summary>Roteiro completo (versão {detail.script.version})</summary><p className="pre">{detail.script.body}</p></details>
              </div>
            )}
            {detail?.reference?.styleProfile && (
              <div className="panel">
                <span className="panel-title">Perfil de estilo da referência</span>
                <dl className="profile">{Object.entries(detail.reference.styleProfile).filter(([k]) => PROFILE_LABEL[k]).map(([k, v]) => (
                  <div key={k}><dt>{PROFILE_LABEL[k]}</dt><dd>{k === 'talkingHead' ? talkingText(v as TalkingHeadInfo) : Array.isArray(v) ? v.join(' · ') : String(v)}</dd></div>
                ))}</dl>
              </div>
            )}
            {detail?.script && (
              <div className="panel full">
                <span className="panel-title">Plano de cenas · {detail.script.scenes.length}</span>
                <div className="table-wrap"><table>
                  <thead><tr><th>Tempo</th><th>Narração</th><th>Mídia</th></tr></thead>
                  <tbody>{detail.script.scenes.map((s) => (
                    <tr key={s.index}>
                      <td>{fmtDuration(s.startS)}–{fmtDuration(s.endS)}</td>
                      <td>{s.narration}{s.onScreenText && <small className="muted">Na tela: {s.onScreenText}</small>}</td>
                      <td className="muted">{sceneMedia(s)}</td>
                    </tr>))}
                  </tbody>
                </table></div>
              </div>
            )}
          </div>
        </Section>
      )}
    </div>
  )
}
