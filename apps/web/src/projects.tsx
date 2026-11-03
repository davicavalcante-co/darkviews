import { useEffect, useState } from 'react'
import type { ProgressEvent, ProjectStatus } from '@corte/shared'
import { api } from './api'
import { PageHead, Section } from './ui'

const STATUS_LABEL: Record<ProjectStatus, string> = {
  queued: 'Na fila', analyzing: 'Analisando referência', scripting: 'Escrevendo roteiro', media: 'Buscando imagens',
  rendering: 'Criando vídeo', editing: 'Em edição', in_approval: 'Aguardando aprovação', approved: 'Aprovado', failed: 'Falhou',
}
const STAGES = ['Na fila', 'Analisando referência', 'Escrevendo roteiro', 'Buscando imagens', 'Gerando áudio', 'Criando vídeo', 'Pronto']

function stageIndex(e: ProgressEvent) {
  switch (e.status) {
    case 'queued': return 0
    case 'analyzing': return 1
    case 'scripting': return 2
    case 'media': return e.job?.stage?.includes('áudio') ? 4 : 3
    case 'rendering': return 5
    case 'failed': return -1
    default: return 6
  }
}

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

  async function remove(p: ProjectRow) {
    if (!confirm(`Excluir "${p.name}"? Os arquivos enviados também serão apagados.`)) return
    try { await api(`/projects/${p.id}`, { method: 'DELETE' }); load() } catch (e) { alert((e as Error).message) }
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
                <td>{(isAdmin || p.status !== 'approved') && <button className="link" onClick={() => remove(p)}>Excluir</button>}</td>
              </tr>))}
            </tbody>
          </table></div>
        )}
      </div>
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
                <dl className="profile">{Object.entries(detail.reference.styleProfile).map(([k, v]) => (
                  <div key={k}><dt>{k}</dt><dd>{Array.isArray(v) ? v.join(', ') : String(v)}</dd></div>
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
