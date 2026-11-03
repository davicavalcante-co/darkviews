import { useEffect, useState, type FormEvent } from 'react'
import {
  detectPlatform, IMAGE_MAX_BYTES, IMAGE_TYPES, MAX_DURATION_S, VIDEO_MAX_BYTES, VIDEO_TYPES,
  type ProgressEvent, type ProjectStatus,
} from '@corte/shared'
import { api, useFonts } from './api'

const STATUS_LABEL: Record<ProjectStatus, string> = {
  queued: 'Na fila', analyzing: 'Analisando referência', scripting: 'Escrevendo roteiro', media: 'Buscando imagens',
  rendering: 'Criando vídeo', editing: 'Em edição', in_approval: 'Aguardando aprovação', approved: 'Aprovado', failed: 'Falhou',
}
const STAGES = ['Na fila', 'Analisando referência', 'Escrevendo roteiro', 'Buscando imagens', 'Gerando áudio', 'Criando vídeo', 'Pronto']
const PLATFORM_LABEL = { youtube: 'YouTube', instagram: 'Instagram', kwai: 'Kwai', tiktok: 'TikTok' }

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

export function ProjectList({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<ProjectRow[] | null>(null)
  const load = () => api<ProjectRow[]>('/projects').then(setRows)
  useEffect(() => { load() }, [])

  async function remove(p: ProjectRow) {
    if (!confirm(`Excluir "${p.name}"? Os arquivos enviados também serão apagados.`)) return
    try { await api(`/projects/${p.id}`, { method: 'DELETE' }); load() } catch (e) { alert((e as Error).message) }
  }

  if (!rows) return null
  return (
    <section>
      <div className="row"><h2>Projetos</h2><a className="btn" href="#/novo">Novo vídeo</a></div>
      {rows.length === 0 ? <p className="muted">Nenhum projeto ainda.</p> : (
        <table>
          <thead><tr><th>Nome</th>{isAdmin && <th>Dono</th>}<th>Duração</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.id}>
              <td><a href={`#/projeto/${p.id}`}>{p.name}</a></td>
              {isAdmin && <td>{p.owner.name}</td>}
              <td>{fmtDuration(p.targetDurationS)}</td>
              <td>{STATUS_LABEL[p.status]}</td>
              <td>{(isAdmin || p.status !== 'approved') && <button className="link" onClick={() => remove(p)}>Excluir</button>}</td>
            </tr>))}
          </tbody>
        </table>
      )}
    </section>
  )
}

type Img = { file: File; caption: string; url: string }

export function NewVideo() {
  const fonts = useFonts()
  const [link, setLink] = useState('')
  const [video, setVideo] = useState<File | null>(null)
  const [images, setImages] = useState<Img[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const platform = link ? detectPlatform(link) : null

  useEffect(() => () => images.forEach((i) => URL.revokeObjectURL(i.url)), []) // eslint-disable-line react-hooks/exhaustive-deps

  function addImages(files: FileList | null) {
    const bad = [...(files ?? [])].find((f) => !IMAGE_TYPES.includes(f.type) || f.size > IMAGE_MAX_BYTES)
    if (bad) return setError(`"${bad.name}": use JPG, PNG ou WebP de até 20 MB`)
    setError('')
    setImages((cur) => [...cur, ...[...files!].map((file) => ({ file, caption: '', url: URL.createObjectURL(file) }))])
  }
  function pickVideo(f: File | undefined) {
    if (f && (!VIDEO_TYPES.includes(f.type) || f.size > VIDEO_MAX_BYTES)) return setError('Vídeo: use MP4, MOV ou WebM de até 2 GB')
    setError(''); setVideo(f ?? null)
  }
  const move = (i: number, d: -1 | 1) => setImages((cur) => {
    const next = [...cur]; const j = i + d
    if (j < 0 || j >= next.length) return cur
    ;[next[i], next[j]] = [next[j], next[i]]
    return next
  })

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const seconds = Math.round(Number(form.get('minutes')) * 60)
    if (!(seconds >= 15 && seconds <= MAX_DURATION_S)) return setError('Duração entre 15 segundos e 18 minutos')
    if (link && !platform) return setError('Link precisa ser de YouTube, Instagram, Kwai ou TikTok')
    if (link && video) return setError('Use link ou vídeo de referência, não os dois')

    const body = new FormData()
    for (const k of ['name', 'prompt', 'fontFamily', 'highlightMode']) body.append(k, String(form.get(k)))
    body.append('targetDurationS', String(seconds))
    if (link) body.append('link', link)
    body.append('captions', JSON.stringify(images.map((i) => i.caption)))
    if (video) body.append('video', video)
    images.forEach((i) => body.append('images', i.file))

    setBusy(true); setError('')
    try {
      const { id } = await api<{ id: string }>('/projects', { method: 'POST', body })
      location.hash = `#/projeto/${id}`
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <h2>Novo vídeo</h2>
      <label>Nome do projeto<input name="name" required maxLength={120} /></label>
      <label>Prompt<textarea name="prompt" required maxLength={5000} rows={5}
        placeholder="Sobre o que é o vídeo, público, tom, chamada para ação…" /></label>

      <fieldset>
        <legend>Referência (opcional)</legend>
        <label>Link
          <input value={link} onChange={(e) => setLink(e.target.value)} disabled={!!video} placeholder="https://www.youtube.com/watch?v=…" />
          {link && <small className={platform ? 'ok' : 'error'}>{platform ? `Plataforma: ${PLATFORM_LABEL[platform]}` : 'Plataforma não suportada'}</small>}
        </label>
        <label>Ou envie o vídeo (MP4, MOV ou WebM até 2 GB)
          <input type="file" accept="video/mp4,video/quicktime,video/webm" disabled={!!link} onChange={(e) => pickVideo(e.target.files?.[0])} />
        </label>
      </fieldset>

      <fieldset>
        <legend>Imagens (JPG, PNG ou WebP até 20 MB)</legend>
        <input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(e) => { addImages(e.target.files); e.target.value = '' }} />
        {images.map((img, i) => (
          <div className="img-row" key={img.url}>
            <img src={img.url} alt="" />
            <input aria-label={`Legenda da imagem ${i + 1}`} placeholder="Legenda curta: fachada da loja" value={img.caption} maxLength={200}
              onChange={(e) => setImages((cur) => cur.map((c, j) => j === i ? { ...c, caption: e.target.value } : c))} />
            <button type="button" className="link" aria-label="Subir" onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="link" aria-label="Descer" onClick={() => move(i, 1)}>↓</button>
            <button type="button" className="link" aria-label="Remover" onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
      </fieldset>

      <div className="grid">
        <label>Duração (minutos, até 18)<input name="minutes" type="number" min={0.25} max={18} step={0.25} defaultValue={3} required /></label>
        <label>Formato<input value="16:9 · 1920×1080" disabled /></label>
        <label>Fonte das legendas<select name="fontFamily">{fonts.map((f) => <option key={f}>{f}</option>)}</select></label>
        <label>Estilo de destaque<select name="highlightMode">
          <option value="palavra-chave">Palavras-chave</option><option value="karaokê">Karaokê</option><option value="manual">Manual</option>
        </select></label>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      <button disabled={busy}>{busy ? 'Enviando…' : 'Criar vídeo'}</button>
    </form>
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

  if (missing) return <p>Projeto não encontrado. <a href="#/">Voltar</a></p>
  if (!ev) return null
  const current = stageIndex(ev)
  const waiting = ev.job?.status === 'queued'
  return (
    <section>
      <p><a href="#/">← Projetos</a></p>
      <h2>{name}</h2>
      {current === -1 ? (
        <p className="error" role="alert">Falhou: {ev.job?.error ?? 'erro desconhecido'}</p>
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
      {ev.job?.status === 'paused' && <p className="warn" role="status">Pausado: {(ev.job.stage ?? "").replace(/\.$/, "")}. Volta sozinho quando o Claude estiver disponível.</p>}

      {detail?.video && (
        <section>
          <video className="player" controls preload="metadata" src={`/api/projects/${id}/video?v=${detail.video.version}`} />
          <p className="muted">Versão {detail.video.version} · {fmtDuration(detail.video.durationS)} · <a href={`/api/projects/${id}/video?download=1`}>Baixar MP4</a> · <a className="btn" href={`#/editar/${id}`}>Editar</a> <a className="btn" href={`#/aprovar/${id}`}>{ev.status === 'approved' ? 'Cortes' : 'Aprovar'}</a></p>
        </section>
      )}

      {detail?.reference?.styleProfile && (
        <details>
          <summary>Perfil de estilo da referência</summary>
          <dl className="profile">{Object.entries(detail.reference.styleProfile).map(([k, v]) => (
            <div key={k}><dt>{k}</dt><dd>{Array.isArray(v) ? v.join(', ') : String(v)}</dd></div>
          ))}</dl>
        </details>
      )}

      {detail?.script && (
        <section>
          <h3>{detail.metadata.title}</h3>
          <p className="pre">{detail.metadata.description}</p>
          <p className="muted">Palavras-chave: {detail.metadata.keywords}</p>
          <details><summary>Roteiro (versão {detail.script.version})</summary><p className="pre">{detail.script.body}</p></details>
          <h4>Plano de cenas ({detail.script.scenes.length})</h4>
          <table>
            <thead><tr><th>Tempo</th><th>Narração</th><th>Mídia</th></tr></thead>
            <tbody>{detail.script.scenes.map((s) => (
              <tr key={s.index}>
                <td>{fmtDuration(s.startS)}–{fmtDuration(s.endS)}</td>
                <td>{s.narration}{s.onScreenText && <small className="muted">Na tela: {s.onScreenText}</small>}</td>
                <td>{sceneMedia(s)}</td>
              </tr>))}
            </tbody>
          </table>
        </section>
      )}
    </section>
  )
}
