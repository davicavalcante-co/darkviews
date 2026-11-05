import { useEffect, useState } from 'react'
import type { ProgressEvent, ProjectStatus } from '@corte/shared'
import { api } from './api'
import { Modal, PageHead, Section } from './ui'

const STATUS_LABEL: Record<ProjectStatus, string> = {
  queued: 'Na fila', analyzing: 'Analisando referência', scripting: 'Escrevendo roteiro', talking_head: 'Aguardando sua escolha: pessoa falando', media: 'Buscando imagens', image_review: 'Aguardando sua aprovação das imagens',
  rendering: 'Criando vídeo', editing: 'Em edição', in_approval: 'Aguardando aprovação', approved: 'Aprovado', failed: 'Falhou',
}
const STAGES = ['Na fila', 'Analisando referência', 'Escrevendo roteiro', 'Buscando imagens', 'Gerando áudio', 'Criando vídeo', 'Pronto']

function stageIndex(e: ProgressEvent) {
  switch (e.status) {
    case 'queued': return 0
    case 'analyzing': return 1
    case 'scripting': return 2
    case 'media': return e.job?.stage?.includes('áudio') ? 4 : 3
    case 'image_review': return 3
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

type ProjectRow = { id: string; name: string; status: ProjectStatus; targetDurationS: number; createdAt: string; owner: { name: string } }

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
      <div className="panel">
        {rows.length === 0 ? <p className="muted">{empty}</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Nome</th>{isAdmin && <th>Dono</th>}<th>Duração</th><th>Status</th><th>Criado em</th><th /></tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id}>
                <td><a href={href(p.id)}><strong>{p.name}</strong></a></td>
                {isAdmin && <td>{p.owner.name}</td>}
                <td>{fmtDuration(p.targetDurationS)}</td>
                <td><span className="pill"><span className={`dot ${p.status === 'approved' ? 'on' : p.status === 'failed' ? 'off' : ''}`} />{STATUS_LABEL[p.status]}</span></td>
                <td className="muted">{new Date(p.createdAt).toLocaleDateString('pt-BR')}</td>
                <td>{(isAdmin || p.status !== 'approved') && <button className="link" onClick={() => { setDelError(''); setToDelete(p) }}>Excluir</button>}</td>
              </tr>))}
            </tbody>
          </table></div>
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

type ReviewScene = { index: number; narration: string | null; assetId: string; kind: 'image' | 'video'; bank: string; credit: string | null }

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

function ImageReview({ id }: { id: string }) {
  const [scenes, setScenes] = useState<ReviewScene[] | null>(null)
  const [swap, setSwap] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { api<{ scenes: ReviewScene[] }>(`/projects/${id}/review`).then((r) => setScenes(r.scenes)).catch((e) => setError(e.message)) }, [id])
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
          <p className="muted">Todas começam aprovadas. Clique em <b>Trocar</b> nas que não servem: o sistema busca outra opção só para essas cenas e mostra de novo.</p>
        </div>
        <button type="button" disabled={busy} onClick={send}>
          {busy ? 'Enviando…' : swap.size ? `Trocar ${swap.size} e aprovar o resto` : 'Aprovar todas e continuar'}
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
              <button type="button" className={swap.has(s.index) ? 'ghost-btn on' : 'ghost-btn'} aria-pressed={swap.has(s.index)} onClick={() => toggle(s.index)}>
                {swap.has(s.index) ? 'Vai trocar ✕' : 'Trocar'}
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

// Saída para vídeo que falhou: explica em uma frase e repete só a etapa que deu erro.
function Retry({ id, error }: { id: string; error: string | null }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
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
      </div>
      {msg && <p className="error" role="alert">{msg}</p>}
    </div>
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
              <Retry id={id} error={ev.job?.error ?? null} />
            ) : (
              <>
                <ol className="stages">{STAGES.map((s, i) => (
                  <li key={s} className={i < current ? 'done' : i === current ? 'now' : ''}>{s}</li>
                ))}</ol>
                <progress max={100} value={ev.job?.progress ?? 0} aria-label="Progresso da etapa" />
                <p className="muted">
                  {ev.job?.stage ?? STAGES[current]} · {ev.job?.progress ?? 0}%
                  {ev.job?.etaS ? ` · cerca de ${fmtDuration(ev.job.etaS)} restantes` : waiting ? ' · aguardando na fila' : ''}
                </p>
              </>
            )}
            {ev.status === 'image_review' && <p className="warn" role="status">Escolha das imagens pronta: aprove abaixo para seguir para a narração.</p>}
            {ev.job?.status === 'paused' && <p className="warn" role="status">Pausado: {(ev.job.stage ?? '').replace(/\.$/, '')}. Volta sozinho quando o Claude estiver disponível.</p>}
          </div>
          {detail?.video && (
            <div className="panel wide">
              <video className="player" controls preload="metadata" src={`/api/projects/${id}/video?v=${detail.video.version}`} />
              <p className="muted">Versão {detail.video.version} · {fmtDuration(detail.video.durationS)}</p>
            </div>
          )}
        </div>
      </Section>

      {ev.status === 'talking_head' && <Section idx={1} title="Pessoa falando"><TalkingHead id={id} /></Section>}
      {ev.status === 'image_review' && <Section idx={1} title="Aprovar imagens"><ImageReview key={ev.job?.type ?? ''} id={id} /></Section>}

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
