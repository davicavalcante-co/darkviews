import { useEffect, useRef, useState, type FormEvent } from 'react'
import { detectPlatform, IMAGE_MAX_BYTES, IMAGE_TYPES, MAX_DURATION_S, VIDEO_MAX_BYTES, VIDEO_TYPES, type ProjectStatus } from '@corte/shared'
import { api, uploadFont, useFonts } from './api'

// "Novo vídeo" em formato de estúdio: configuração numa coluna à esquerda e as criações ao lado.
type Creation = {
  id: string; name: string; prompt: string; status: ProjectStatus; targetDurationS: number; aspect: string; createdAt: string; images: number
  video: { version: number; durationS: number } | null
  job: { stage: string | null; progress: number; status: string; etaS: number | null } | null
}
type Img = { file: File; caption: string; url: string }

const STATUS: Record<ProjectStatus, string> = {
  queued: 'Na fila', analyzing: 'Analisando', scripting: 'Escrevendo roteiro', media: 'Buscando mídia', rendering: 'Criando vídeo',
  editing: 'Pronto · em edição', in_approval: 'Aguardando aprovação', approved: 'Aprovado', failed: 'Falhou',
}
const PLATFORM_LABEL = { youtube: 'YouTube', instagram: 'Instagram', kwai: 'Kwai', tiktok: 'TikTok' }
const FILTERS = [['all', 'Todas'], ['running', 'Em andamento'], ['ready', 'Prontas']] as const
const READY: ProjectStatus[] = ['editing', 'in_approval', 'approved']
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'agora'
  if (s < 3600) return `há ${Math.floor(s / 60)} min`
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`
  const d = Math.floor(s / 86400)
  return d < 30 ? `há ${d} ${d === 1 ? 'dia' : 'dias'}` : `há ${Math.floor(d / 30)} ${d < 60 ? 'mês' : 'meses'}`
}

export function NewVideo() {
  return (
    <div className="studio">
      <Composer />
      <Creations />
    </div>
  )
}

function Composer() {
  const fonts = useFonts()
  const fileRef = useRef<HTMLInputElement>(null)
  const [link, setLink] = useState('')
  const [video, setVideo] = useState<File | null>(null)
  const [images, setImages] = useState<Img[]>([])
  const [minutes, setMinutes] = useState(3)
  const [font, setFont] = useState('')
  const [fontBusy, setFontBusy] = useState(false)
  useEffect(() => { if (!font && fonts.length) setFont(fonts[0]) }, [fonts])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const platform = link ? detectPlatform(link) : null
  const maxMin = MAX_DURATION_S / 60

  useEffect(() => () => images.forEach((i) => URL.revokeObjectURL(i.url)), []) // eslint-disable-line react-hooks/exhaustive-deps

  const [imgError, setImgError] = useState('')
  const [dragging, setDragging] = useState(false)
  // Copia a lista na hora: o campo é limpo logo depois e a FileList esvazia junto (era por isso que as fotos sumiam).
  function addImages(list: FileList | null) {
    const files = [...(list ?? [])]
    const ok = files.filter((f) => IMAGE_TYPES.includes(f.type) && f.size <= IMAGE_MAX_BYTES)
    const bad = files.filter((f) => !ok.includes(f))
    setImgError(bad.length ? `${bad.length === 1 ? `"${bad[0].name}" não entrou` : `${bad.length} arquivos não entraram`}: use fotos JPG, PNG ou WebP de até 20 MB.` : '')
    if (ok.length) setImages((cur) => [...cur, ...ok.map((file) => ({ file, caption: '', url: URL.createObjectURL(file) }))])
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
  const step = (d: number) => setMinutes((m) => Math.min(maxMin, Math.max(0.5, Math.round((m + d) * 2) / 2)))

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const seconds = Math.round(minutes * 60)
    if (!(seconds >= 15 && seconds <= MAX_DURATION_S)) return setError('Duração entre 15 segundos e 18 minutos')
    if (link && !platform) return setError('Link precisa ser de YouTube, Instagram, Kwai ou TikTok')
    if (link && video) return setError('Use link ou vídeo de referência, não os dois')

    const body = new FormData()
    for (const k of ['name', 'prompt', 'fontFamily', 'highlightMode', 'voiceBrief']) body.append(k, String(form.get(k) ?? ''))
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
    <form className="composer" onSubmit={submit}>
      <div className="composer-head">
        <div><span className="kicker">Estúdio</span><h1>Novo vídeo</h1></div>
        <span className="muted">até 18 min</span>
      </div>

      <div className="composer-body">
        <label className="field-label">Nome<input name="name" required maxLength={120} placeholder="Ex.: Lançamento do café especial" /></label>

        <div className="field">
          <div className="field-label">Referência <span className="muted">opcional</span></div>
          <input value={link} onChange={(e) => setLink(e.target.value)} disabled={!!video} aria-label="Link de referência"
            placeholder="Link do YouTube, Instagram, Kwai ou TikTok" />
          {link && <small className={platform ? 'ok' : 'error'}>{platform ? `Plataforma: ${PLATFORM_LABEL[platform]}` : 'Plataforma não suportada'}</small>}
          <label className={`drop${link ? ' disabled' : ''}`}>
            <input type="file" accept="video/mp4,video/quicktime,video/webm" disabled={!!link} onChange={(e) => pickVideo(e.target.files?.[0])} />
            <span aria-hidden="true">▶</span>{video ? video.name : 'ou envie um vídeo (MP4, MOV, WebM)'}
          </label>
        </div>

        <div className="field">
          <div className="field-label">Imagens <span className="muted">{images.length}</span></div>
          <div className={`tiles-sm${dragging ? ' dragging' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); addImages(e.dataTransfer.files) }}>
            {images.map((img, i) => (
              <figure key={img.url} className="thumb">
                <img src={img.url} alt={img.caption || `Imagem ${i + 1}`} />
                <div className="thumb-actions">
                  <button type="button" aria-label="Mover para a esquerda" onClick={() => move(i, -1)}>‹</button>
                  <button type="button" aria-label="Mover para a direita" onClick={() => move(i, 1)}>›</button>
                  <button type="button" aria-label="Remover" onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}>✕</button>
                </div>
                <input aria-label={`Legenda da imagem ${i + 1}`} placeholder="Legenda" value={img.caption} maxLength={200}
                  onChange={(e) => setImages((cur) => cur.map((c, j) => j === i ? { ...c, caption: e.target.value } : c))} />
              </figure>
            ))}
            <button type="button" className="add-tile" onClick={() => fileRef.current?.click()}><span aria-hidden="true">+</span>{images.length ? 'Mais fotos' : 'Adicionar fotos'}</button>
            <input ref={fileRef} type="file" hidden multiple accept="image/jpeg,image/png,image/webp" onChange={(e) => { addImages(e.target.files); e.target.value = '' }} />
          </div>
          {imgError && <p className="error small" role="alert">{imgError}</p>}
          <small className="muted">Selecione várias de uma vez (ou arraste para cá). Uma legenda curta ("fachada da loja") ajuda o Claude a pôr cada foto na cena certa.</small>
        </div>

        <label className="field-label">Voz desejada <span className="muted">opcional</span>
          <input name="voiceBrief" maxLength={200} placeholder="Ex.: mulher jovem, animada, ritmo rápido" />
          <small className="muted">Com o OmniVoice ligado, o Claude Code cria essa voz para o vídeo.</small>
        </label>

        <label className="field-label">Prompt
          <textarea name="prompt" required maxLength={5000} rows={7} placeholder="Sobre o que é o vídeo, público, tom, chamada para ação…" />
        </label>
      </div>

      <div className="composer-foot">
        <div className="chips">
          <div className="stepper" role="group" aria-label="Duração em minutos">
            <button type="button" aria-label="Menos" onClick={() => step(-0.5)}>−</button>
            <span>{fmt(minutes * 60)}</span>
            <button type="button" aria-label="Mais" onClick={() => step(0.5)}>+</button>
          </div>
          <span className="chip" title="Formato do vídeo principal">16:9</span>
          <select name="fontFamily" className="chip" aria-label="Fonte das legendas" value={font} onChange={(e) => setFont(e.target.value)}>
            {[...new Set([font, ...fonts])].filter(Boolean).map((f) => <option key={f}>{f}</option>)}
          </select>
          <label className="chip upload-chip" title="Enviar uma fonte .ttf ou .otf">
            {fontBusy ? 'Enviando…' : '+ fonte'}
            <input type="file" accept=".ttf,.otf,font/ttf,font/otf" hidden disabled={fontBusy} onChange={async (e) => {
              const f = e.target.files?.[0]; e.target.value = ''
              if (!f) return
              setFontBusy(true); setError('')
              try { setFont(await uploadFont(f)) } catch (err) { setError((err as Error).message) } finally { setFontBusy(false) }
            }} />
          </label>
          <select name="highlightMode" className="chip" aria-label="Destaque da legenda">
            <option value="palavra-chave">Palavras-chave</option><option value="karaokê">Karaokê</option><option value="manual">Manual</option>
          </select>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="cta" disabled={busy}>{busy ? 'Enviando…' : 'Criar vídeo'} <span aria-hidden="true">→</span></button>
      </div>
    </form>
  )
}

function Creations() {
  const [rows, setRows] = useState<Creation[] | null>(null)
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all')
  const [q, setQ] = useState('')
  const load = () => api<Creation[]>('/projects').then(setRows).catch(() => setRows([]))
  useEffect(() => { load() }, [])
  // Enquanto algum vídeo estiver sendo criado, atualiza a cada 4 s.
  useEffect(() => {
    if (!rows?.some((r) => r.job)) return
    const t = setTimeout(load, 4000)
    return () => clearTimeout(t)
  }, [rows])

  const shown = (rows ?? []).filter((r) =>
    (filter === 'all' || (filter === 'ready' ? READY.includes(r.status) : !READY.includes(r.status) && r.status !== 'failed'))
    && (!q || `${r.name} ${r.prompt}`.toLowerCase().includes(q.toLowerCase())))

  return (
    <section className="creations" aria-label="Criações">
      <div className="creations-bar">
        <div className="seg" role="tablist">
          {FILTERS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>{label}</button>)}
        </div>
        <input className="search" type="search" placeholder="Buscar criações" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar criações" />
      </div>

      {!rows ? null : shown.length === 0 ? (
        <div className="creations-empty">
          <strong>{rows.length ? 'Nada com esse filtro.' : 'Suas criações aparecem aqui.'}</strong>
          <p className="muted">{rows.length ? 'Troque o filtro ou a busca.' : 'Preencha o prompt ao lado e clique em Criar vídeo. Você acompanha a análise, o roteiro e o render por aqui.'}</p>
        </div>
      ) : (
        <div className="feed">{shown.map((r) => <CreationRow key={r.id} r={r} />)}</div>
      )}
    </section>
  )
}

function CreationRow({ r }: { r: Creation }) {
  const frames = r.video ? [0.12, 0.37, 0.62, 0.87].map((f) => +(r.video!.durationS * f).toFixed(1)) : []
  return (
    <article className="creation">
      <header>
        <a href={`#/projeto/${r.id}`} className="creation-title"><strong>{r.name}</strong><span className="muted">{r.prompt}</span></a>
        <div className="chips">
          <span className="chip">{r.aspect}</span>
          <span className="chip">{fmt(r.video?.durationS ?? r.targetDurationS)}</span>
          {r.images > 0 && <span className="chip">{r.images} {r.images === 1 ? 'imagem' : 'imagens'}</span>}
          <span className={`chip status ${r.status}`}>{STATUS[r.status]}</span>
          <span className="muted when">{ago(r.createdAt)}</span>
        </div>
      </header>
      <div className="frames">
        {r.video ? frames.map((t) => (
          <a key={t} href={`#/editar/${r.id}`} className="frame">
            <img src={`/api/projects/${r.id}/frame?t=${t}&v=${r.video!.version}`} alt="" loading="lazy" />
            <span className="frame-tag">{fmt(t)}</span>
          </a>
        )) : (
          <a href={`#/projeto/${r.id}`} className={`frame working${r.status === 'failed' ? ' failed' : ''}`}>
            <span className="working-stage">{r.status === 'failed' ? 'Falhou — abrir para ver o motivo' : r.job?.status === 'paused' ? 'Pausado' : (r.job?.stage ?? STATUS[r.status])}</span>
            {r.status !== 'failed' && <span className="bar"><span style={{ width: `${r.job?.progress ?? 0}%` }} /></span>}
            {r.job?.etaS ? <span className="muted">cerca de {fmt(r.job.etaS)} restantes</span> : null}
          </a>
        )}
      </div>
      <footer>
        <a href={`#/projeto/${r.id}`}>Andamento</a>
        {r.video && <a href={`#/editar/${r.id}`}>Editar</a>}
        {r.video && <a href={`#/aprovar/${r.id}`}>{r.status === 'approved' ? 'Cortes' : 'Aprovar'}</a>}
      </footer>
    </article>
  )
}
