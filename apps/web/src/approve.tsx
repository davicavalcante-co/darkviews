import { useEffect, useRef, useState } from 'react'
import { CUT_LABELS, CUT_LIMITS, planCuts, type CutPlatform } from '@corte/shared'
import { api } from './api'
import { PageHead, Section } from './ui'

type Cut = { id: string; platform: CutPlatform; partIndex: number; startS: number; endS: number; background: 'blur' | 'color'; status: string }
type CutsData = { status: string; approvedAt: string | null; job: { stage: string | null; progress: number } | null; cuts: Cut[] }
type Detail = { name: string; status: string; video: { version: number; durationS: number } | null }

const PLATFORMS = Object.keys(CUT_LIMITS) as CutPlatform[]
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const STATUS: Record<string, string> = { queued: 'na fila', running: 'gerando…', done: 'pronto', failed: 'falhou' }

const BG_LABEL = { blur: 'vídeo embaçado', color: 'cor de fundo' } as const

export function ApprovePage({ id, embedded }: { id: string; embedded?: boolean }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [data, setData] = useState<CutsData | null>(null)
  const [platforms, setPlatforms] = useState<CutPlatform[]>(['shorts', 'reels'])
  const [startS, setStart] = useState(0)
  const [endS, setEnd] = useState(60)
  const [partS, setPartS] = useState(60)
  const [background, setBackground] = useState<'blur' | 'color'>('blur')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLVideoElement>(null)

  const load = () => Promise.all([api<Detail>(`/projects/${id}`).then(setDetail), api<CutsData>(`/projects/${id}/cuts`).then(setData)])
  useEffect(() => { load().catch(() => setError('Projeto não encontrado')) }, [id])
  // Trecho padrão: do fim do último corte já feito (não repete segundos) até o fim do vídeo.
  const lastEnd = Math.max(0, ...(data?.cuts ?? []).map((c) => c.endS))
  useEffect(() => { if (!detail?.video) return; const d = detail.video.durationS; setStart(lastEnd < d - 3 ? lastEnd : 0); setEnd(d) }, [detail?.video?.durationS, lastEnd])
  // Atualiza enquanto os cortes são gerados.
  useEffect(() => {
    if (!data?.job && !data?.cuts.some((c) => c.status === 'queued' || c.status === 'running')) return
    const t = setTimeout(load, 2000)
    return () => clearTimeout(t)
  }, [data])

  if (error && !detail) return <p>{error} <a href="#/">Voltar</a></p>
  if (!detail || !data) return null
  if (!detail.video) return <p>O vídeo ainda não está pronto. <a href={`#/projeto/${id}`}>Ver andamento</a></p>
  const dur = detail.video.durationS
  const now = () => Math.round((ref.current?.currentTime ?? 0) * 10) / 10

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await fn(); await load() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="page">
      {!embedded && <PageHead back={{ href: `#/editar/${id}`, label: 'Edição' }} title={detail.name}
        kicker={data.approvedAt ? `Aprovado em ${new Date(data.approvedAt).toLocaleString('pt-BR')}` : 'Aprovação'} />}
      {data.job && <p className="warn" role="status">{data.job.stage} · {data.job.progress}%</p>}

      <Section idx={1} title={data.approvedAt ? 'Gerar mais cortes' : 'Trecho e enquadramento'}>
        <div className="cards">
          <div className="panel wide">
            <video ref={ref} className="player" controls preload="metadata" src={`/api/projects/${id}/video?v=${detail.video.version}`} />
            <div className="grid">
              <label>Início do trecho (s)
                <input type="number" min={0} max={dur} step={0.1} value={startS} onChange={(e) => setStart(Number(e.target.value))} />
                <button type="button" className="link" onClick={() => setStart(now())}>usar posição do player</button>
              </label>
              <label>Fim do trecho (s)
                <input type="number" min={0} max={dur} step={0.1} value={endS} onChange={(e) => setEnd(Number(e.target.value))} />
                <button type="button" className="link" onClick={() => setEnd(now())}>usar posição do player</button>
              </label>
            </div>
            <label>Duração de cada corte (s)
              <input type="number" min={3} max={180} step={1} value={partS} onChange={(e) => setPartS(Number(e.target.value))} />
            </label>
            <p className="muted">Trecho de {fmt(startS)} a {fmt(Math.min(endS, dur))}, em cortes seguidos de {partS} s (sem repetir segundos). Cada plataforma respeita o seu limite; Stories sempre em partes de 15 s.</p>
            {platforms.length > 0 && endS - startS >= 3 && (
              <p className="muted small">{platforms.map((p) => { const c = planCuts({ platforms: [p], startS, endS, partS }, dur); return `${CUT_LABELS[p]}: ${c.length} ${c.length === 1 ? 'corte' : 'cortes'} (${c.slice(0, 3).map((x) => `${fmt(x.startS)}–${fmt(x.endS)}`).join(', ')}${c.length > 3 ? '…' : ''})` }).join(' · ')}</p>
            )}
          </div>

          <fieldset>
            <legend>Cortes verticais 9:16</legend>
            <div className="stack">
              {PLATFORMS.map((p) => (
                <label key={p} className="check">
                  <input type="checkbox" checked={platforms.includes(p)} onChange={(e) => setPlatforms(e.target.checked ? [...platforms, p] : platforms.filter((x) => x !== p))} />
                  <span>{CUT_LABELS[p]} <small className="muted">{p === 'stories' ? 'partes de 15 s' : `até ${CUT_LIMITS[p]} s`}</small></span>
                </label>
              ))}
            </div>
            <div className="field-label">Fundo atrás do vídeo</div>
            <div className="stack">
              {(['blur', 'color'] as const).map((b) => (
                <label key={b} className="check"><input type="radio" name="fundo" checked={background === b} onChange={() => setBackground(b)} /><span>{b === 'blur' ? 'Vídeo embaçado' : 'Cor de fundo do vídeo'}</span></label>
              ))}
            </div>
            <p className="muted small">O vídeo horizontal aparece inteiro, um pouco menor, no meio da tela vertical. A legenda fica no fundo, abaixo dele.</p>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="row">
              {detail.status === 'editing'
                ? <button type="button" className="link" disabled={busy} onClick={() => run(() => api(`/projects/${id}/submit`, { method: 'POST' }))}>Enviar para aprovação</button>
                : <span />}
              <button type="button" disabled={busy || !platforms.length || !!data.job}
                onClick={() => run(() => api(`/projects/${id}/approve`, { method: 'POST', body: { platforms, startS, endS, partS, background } }))}>
                {data.approvedAt ? 'Gerar cortes' : 'Aprovar e gerar cortes'}
              </button>
            </div>
          </fieldset>
        </div>
      </Section>

      {data.cuts.length > 0 && (
        <Section idx={2} title={`Cortes · ${data.cuts.length}`}>
          <div className="cuts">{data.cuts.map((c) => <CutCard key={c.id} id={id} cut={c} disabled={!!data.job} onRedo={(x) => run(() => api(`/projects/${id}/cuts/${c.id}/redo`, { method: 'POST', body: { background: x } }))} />)}</div>
        </Section>
      )}
    </div>
  )
}

function CutCard({ id, cut, disabled, onRedo }: { id: string; cut: Cut; disabled: boolean; onRedo: (background: 'blur' | 'color') => void }) {
  const file = `/api/projects/${id}/cuts/${cut.id}/file`
  const other = cut.background === 'blur' ? 'color' : 'blur'
  return (
    <article className="cut">
      <strong>{CUT_LABELS[cut.platform]} · parte {cut.partIndex + 1}</strong>
      <small className="muted">{fmt(cut.startS)}–{fmt(cut.endS)} · {STATUS[cut.status] ?? cut.status}</small>
      {cut.status === 'done' && <video controls preload="metadata" src={file} />}
      {cut.status === 'done' && <a className="btn" href={`${file}?download=1`}>Baixar</a>}
      <button type="button" className="link" disabled={disabled} onClick={() => onRedo(other)}>Refazer com {BG_LABEL[other]}</button>
    </article>
  )
}
