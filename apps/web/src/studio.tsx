import { useEffect, useRef, useState, type FormEvent } from 'react'
import { detectPlatform, MUSIC_STYLES, IMAGE_MAX_BYTES, IMAGE_TYPES, MAX_DURATION_S, VIDEO_MAX_BYTES, VIDEO_TYPES, type ProjectStatus } from '@corte/shared'

type Voices = { voices: { id: string; label: string; provider: string; freeText: boolean }[]; current: string | null; tones: readonly { id: string; label: string }[] }
import { api, uploadFont, useFonts } from './api'
import { CaptionPosition, FontSelect, loadFontPreview, Modal } from './ui'
import { compact } from './dashboard'

// "Novo vídeo" em formato de estúdio: configuração numa coluna à esquerda e as criações ao lado.
type Creation = {
  id: string; name: string; prompt: string; status: ProjectStatus; targetDurationS: number; aspect: string; createdAt: string; images: number; tokens: number
  video: { version: number; durationS: number } | null
  versions: { version: number; durationS: number; isCurrent: boolean }[]
  job: { stage: string | null; progress: number; status: string; etaS: number | null } | null
}
type Img = { file?: File; id?: string; caption: string; url: string } // id = imagem já enviada (nova versão)
// Vídeo escolhido no card: os campos vêm preenchidos para gerar outra versão.
type Base = {
  id: string; name: string; prompt: string; targetDurationS: number; options: Record<string, unknown>
  reference: { sourceType: string; url: string | null } | null; assets: { id: string; userCaption: string | null }[]
}

const STATUS: Record<ProjectStatus, string> = {
  queued: 'Na fila', analyzing: 'Analisando', scripting: 'Escrevendo roteiro', talking_head: 'Sua escolha', media: 'Buscando mídia', image_review: 'Aprovar imagens', rendering: 'Criando vídeo',
  editing: 'Pronto · em edição', in_approval: 'Aguardando aprovação', approved: 'Aprovado', failed: 'Falhou',
}
// Estilo de edição: puxa o roteiro para um tipo de movimento e transição.
const EDIT_STYLES: [string, string, string][] = [
  ['auto', 'Automático', 'O Claude mistura Ken Burns, parallax, recorte de revista, zoom rápido e transições conforme cada cena.'],
  ['documentario', 'Documentário', 'Ken Burns suave (zoom e pan lentos) com cortes e dissolves.'],
  ['dinamico', 'Dinâmico', 'Zoom rápido, punch, whip pan e slides: ritmo de YouTube.'],
  ['revista', 'Revista', 'Fotos como recortes de papel, com movimento de stop-motion.'],
  ['profundidade', 'Profundidade 2.5D', 'Parallax: o objeto da foto se separa do fundo e ganha profundidade.'],
]
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
  const [base, setBase] = useState<Base | null>(null)
  const pick = (id: string) => api<Base>(`/projects/${id}`).then((b) => { setBase(b); scrollTo({ top: 0, behavior: 'smooth' }) })
  return (
    <div className="studio">
      <Composer key={base?.id ?? 'novo'} base={base} onCancel={() => setBase(null)} />
      <Creations onPick={pick} picked={base?.id ?? null} />
    </div>
  )
}

function Composer({ base, onCancel }: { base: Base | null; onCancel: () => void }) {
  const o = (base?.options ?? {}) as { fontFamily?: string; voicePreset?: string; voiceTone?: string; highlightColor?: string; captionPosition?: string; captionSize?: number; captionOutline?: boolean; bgColor?: string; useStock?: boolean; musicStyle?: string; musicVolume?: number; editStyle?: string }
  const fonts = useFonts()
  const [name, setName] = useState(base?.name ?? '')
  const [prompt, setPrompt] = useState(base?.prompt ?? '')
  const [captionSize, setCaptionSize] = useState(o.captionSize ?? 64)
  const [outline, setOutline] = useState(o.captionOutline !== false)
  const [bgColor, setBgColor] = useState(o.bgColor ?? '#111418')
  const [useStock, setUseStock] = useState(o.useStock !== false)
  const [preview, setPreview] = useState(false)
  const [editStyle, setEditStyle] = useState(o.editStyle ?? 'auto')
  const [musicStyle, setMusicStyle] = useState(o.musicStyle ?? 'auto')
  const [musicVolume, setMusicVolume] = useState(o.musicVolume ?? 35)
  const fileRef = useRef<HTMLInputElement>(null)
  const [link, setLink] = useState('')
  const [video, setVideo] = useState<File | null>(null)
  const [images, setImages] = useState<Img[]>(() => (base?.assets ?? []).map((a) => ({ id: a.id, caption: a.userCaption ?? '', url: `/api/projects/${base!.id}/assets/${a.id}` })))
  const [minutes, setMinutes] = useState(base ? base.targetDurationS / 60 : 3)
  const [voicePreset, setVoicePreset] = useState(o.voicePreset ?? '')
  const [voiceTone, setVoiceTone] = useState(o.voiceTone ?? 'natural')
  const [font, setFont] = useState(o.fontFamily ?? '')
  const [highlightColor, setHighlightColor] = useState(o.highlightColor ?? '#FFD43B')
  const [captionPosition, setCaptionPosition] = useState(o.captionPosition ?? 'bottom-center')
  const [fontBusy, setFontBusy] = useState(false)
  useEffect(() => { if (!font && fonts.length) setFont(fonts[0]) }, [fonts])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const platform = link ? detectPlatform(link) : null
  const maxMin = MAX_DURATION_S / 60

  useEffect(() => () => images.forEach((i) => i.file && URL.revokeObjectURL(i.url)), []) // eslint-disable-line react-hooks/exhaustive-deps

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
    const seconds = Math.round(minutes * 60)
    if (!(seconds >= 15 && seconds <= MAX_DURATION_S)) return setError('Duração entre 15 segundos e 18 minutos')
    if (link && !platform) return setError('Link precisa ser de YouTube, Instagram, Kwai ou TikTok')
    if (link && video) return setError('Use link ou vídeo de referência, não os dois')

    const body = new FormData()
    body.append('name', name)
    body.append('prompt', prompt)
    body.append('captionSize', String(captionSize))
    body.append('captionOutline', outline ? '1' : '0')
    body.append('bgColor', bgColor)
    body.append('useStock', useStock ? '1' : '0')
    body.append('editStyle', editStyle)
    body.append('musicStyle', musicStyle)
    body.append('musicVolume', String(musicVolume))
    body.append('fontFamily', font)
    body.append('highlightColor', highlightColor)
    body.append('captionPosition', captionPosition)
    body.append('highlightMode', 'palavra-chave')
    body.append('voicePreset', voicePreset)
    body.append('voiceTone', voiceTone)
    body.append('targetDurationS', String(seconds))
    if (base) body.append('order', JSON.stringify(images.map((i) => (i.id ? { id: i.id, caption: i.caption } : { new: true, caption: i.caption }))))
    else {
      if (link) body.append('link', link)
      body.append('captions', JSON.stringify(images.map((i) => i.caption)))
      if (video) body.append('video', video)
    }
    images.forEach((i) => i.file && body.append('images', i.file))

    setBusy(true); setError('')
    try {
      const { id } = await api<{ id: string }>(base ? `/projects/${base.id}/regenerate` : '/projects', { method: 'POST', body })
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
        {base && <div className="notice">Nova versão de <b>{base.name}</b>: ajuste o que quiser; o vídeo novo entra no mesmo card, em primeiro. <button type="button" className="link" onClick={onCancel}>Começar do zero</button></div>}
        <label className="field-label">Nome<input name="name" required maxLength={120} placeholder="Ex.: Lançamento do café especial" value={name} onChange={(e) => setName(e.target.value)} /></label>

        {base ? (
          <div className="field">
            <div className="field-label">Referência <span className="muted">mantida</span></div>
            <p className="muted ellipsis">{base.reference ? (base.reference.url ?? 'Vídeo enviado') : 'Sem referência'}</p>
          </div>
        ) : (
        <div className="field">
            <div className="field-label">Referência <span className="muted">opcional</span></div>
            <input value={link} onChange={(e) => setLink(e.target.value)} disabled={!!video} aria-label="Link de referência"
              placeholder="Link do YouTube, Instagram, Kwai ou TikTok" />
            {link && <small className={platform ? 'ok' : 'error'}>{platform ? `Plataforma: ${PLATFORM_LABEL[platform]}` : 'Plataforma não suportada'}</small>}
            <label className={`drop${link ? ' disabled' : ''}`}>
              <input type="file" accept="video/mp4,video/quicktime,video/webm" disabled={!!link} onChange={(e) => pickVideo(e.target.files?.[0])} />
              <span aria-hidden="true">▶</span><span className="ellipsis">{video ? video.name : 'Enviar vídeo de referência'}</span>
            </label>
          </div>
        )}

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
          <ImagesNeeded seconds={Math.round(minutes * 60)} count={images.length} useStock={useStock} setUseStock={setUseStock} />
          <small className="muted">Selecione várias de uma vez (ou arraste para cá). Uma legenda curta ("fachada da loja") ajuda o Claude a pôr cada foto na cena certa.</small>
        </div>

        <VoicePicker preset={voicePreset} setPreset={setVoicePreset} tone={voiceTone} setTone={setVoiceTone} />

        <label className="field-label">Prompt
          <textarea name="prompt" required maxLength={5000} rows={7} placeholder="Sobre o que é o vídeo, público, tom, chamada para ação…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>

        <div className="field">
          <div className="field-label">Estilo de edição</div>
          <div className="choice-grid" role="radiogroup" aria-label="Estilo de edição">
            {EDIT_STYLES.map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={editStyle === id} className="choice small-choice" onClick={() => setEditStyle(id)}>{label}</button>)}
          </div>
          <small className="muted">{EDIT_STYLES.find(([id]) => id === editStyle)?.[2]}</small>
        </div>

        <div className="field">
          <div className="field-label">Trilha sonora</div>
          <div className="choice-grid" role="radiogroup" aria-label="Estilo da trilha">
            {MUSIC_STYLES.map((m) => <button key={m.id} type="button" role="radio" aria-checked={musicStyle === m.id} className="choice small-choice" onClick={() => setMusicStyle(m.id)}>{m.label}</button>)}
          </div>
          {musicStyle !== 'none' && (
            <label className="range-row">Volume
              <input type="range" min={5} max={80} step={5} value={musicVolume} onChange={(e) => setMusicVolume(Number(e.target.value))} aria-label="Volume da trilha" />
              <b>{musicVolume}%</b>
            </label>
          )}
          <small className="muted">A trilha fica por baixo da narração e abaixa sozinha quando alguém fala. Mais fontes de música em Integrações.</small>
        </div>

        <div className="field">
          <div className="field-label">Legenda <button type="button" className="link" onClick={() => setPreview(true)}>Ver prévia</button></div>
          <div className="controls grid2">
          <div className="control span2">
            <span className="control-label">Fonte da legenda</span>
            <div className="font-row">
              <FontSelect value={font} fonts={fonts} onChange={setFont} />
              <label className="chip upload-chip" title="Enviar uma fonte .ttf ou .otf">
                {fontBusy ? '…' : '+'}
                <input type="file" accept=".ttf,.otf,font/ttf,font/otf" hidden disabled={fontBusy} onChange={async (e) => {
                  const f = e.target.files?.[0]; e.target.value = ''
                  if (!f) return
                  setFontBusy(true); setError('')
                  try { setFont(await uploadFont(f)) } catch (err) { setError((err as Error).message) } finally { setFontBusy(false) }
                }} />
              </label>
            </div>
          </div>
          <div className="control">
            <span className="control-label">Tamanho</span>
            <div className="stepper" role="group" aria-label="Tamanho da legenda">
              <button type="button" aria-label="Menor" onClick={() => setCaptionSize((v) => Math.max(24, v - 4))}>−</button>
              <span>{captionSize}</span>
              <button type="button" aria-label="Maior" onClick={() => setCaptionSize((v) => Math.min(140, v + 4))}>+</button>
            </div>
          </div>
          <div className="control">
            <span className="control-label">Traçado</span>
            <div className="choice-row" role="radiogroup" aria-label="Traçado nas letras">
              <button type="button" role="radio" aria-checked={outline} className="choice small-choice" onClick={() => setOutline(true)}>Com</button>
              <button type="button" role="radio" aria-checked={!outline} className="choice small-choice" onClick={() => setOutline(false)}>Sem</button>
            </div>
          </div>
          <div className="control">
            <span className="control-label">Cor: fundo</span>
            <input type="color" className="color-input" value={bgColor} onChange={(e) => setBgColor(e.target.value.toUpperCase())} aria-label="Cor do fundo do vídeo (aparece nos quadros de texto)" />
          </div>
          <div className="control">
            <span className="control-label">Cor: destaque</span>
            <input type="color" className="color-input" value={highlightColor} onChange={(e) => setHighlightColor(e.target.value.toUpperCase())} aria-label="Cor das palavras em destaque" />
          </div>
          <div className="control span2">
            <span className="control-label">Posição da legenda</span>
            <CaptionPosition value={captionPosition} onChange={setCaptionPosition} />
          </div>
          </div>
        </div>
      </div>
      <Modal open={preview} onClose={() => setPreview(false)} kicker="Legenda" title="Prévia no vídeo" wide>
        <CaptionPreview font={font} size={captionSize} color={highlightColor} outline={outline} position={captionPosition} bg={bgColor} />
        <p className="muted">Assim a legenda aparece no vídeo 16:9 (o fundo só aparece nos quadros de texto).</p>
      </Modal>

      <div className="composer-foot">
        <div className="controls grid2">
          <div className="control">
            <span className="control-label">Duração</span>
            <div className="stepper" role="group" aria-label="Duração em minutos">
              <button type="button" aria-label="Menos" onClick={() => step(-0.5)}>−</button>
              <span>{fmt(minutes * 60)}</span>
              <button type="button" aria-label="Mais" onClick={() => step(0.5)}>+</button>
            </div>
          </div>
          <div className="control">
            <span className="control-label">Formato</span>
            <span className="chip" title="Formato do vídeo principal (os cortes verticais saem na aprovação)">16:9</span>
          </div>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <TokenEstimate seconds={Math.round(minutes * 60)} />
        <button className="cta" disabled={busy}>{busy ? 'Enviando…' : base ? 'Gerar nova versão' : 'Criar vídeo'} <span aria-hidden="true">→</span></button>
      </div>
    </form>
  )
}

// Voz desejada: opções da voz que vai narrar (mudam conforme o fornecedor em uso) e o tom da fala.
function VoicePicker({ preset, setPreset, tone, setTone }: { preset: string; setPreset: (v: string) => void; tone: string; setTone: (v: string) => void }) {
  const [v, setV] = useState<Voices | null>(null)
  useEffect(() => { api<Voices>('/voices').then((r) => { setV(r); if (!preset && r.current) setPreset(r.current) }).catch(() => {}) }, [])
  if (!v?.voices.length) return null
  const chosen = v.voices.find((x) => x.id === preset)
  return (
    <div className="field">
      <label className="field-label" htmlFor="voz">Voz</label>
      <select id="voz" value={chosen ? preset : ''} onChange={(e) => setPreset(e.target.value)}>
        {!chosen && <option value="">{preset ? `Personalizada: ${preset.split(':').slice(1).join(':')}` : 'Escolha uma voz'}</option>}
        {v.voices.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
      </select>
      {(chosen?.freeText || (!chosen && preset.startsWith('omnivoice:'))) && (
        <input value={preset.slice('omnivoice:'.length)} maxLength={50} onChange={(e) => setPreset('omnivoice:' + e.target.value)} placeholder="Ou descreva: mulher jovem, animada…" aria-label="Descrição da voz" />
      )}
      <div className="choice-row" role="radiogroup" aria-label="Tom">
        {v.tones.map((t) => <button key={t.id} type="button" role="radio" aria-checked={tone === t.id} className="choice small-choice" onClick={() => setTone(t.id)}>{t.label}</button>)}
      </div>
    </div>
  )
}

function Creations({ onPick, picked }: { onPick: (id: string) => void; picked: string | null }) {
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
        <div className="feed">{shown.map((r) => <CreationRow key={r.id} r={r} onPick={() => onPick(r.id)} picked={picked === r.id} />)}</div>
      )}
    </section>
  )
}

// Card do vídeo: as versões lado a lado (a mais nova primeiro). Clicar no card preenche o formulário para gerar outra versão.
function CreationRow({ r, onPick, picked }: { r: Creation; onPick: () => void; picked: boolean }) {
  const working = !!r.job || r.status === 'failed'
  const [open, setOpen] = useState<number | null>(null)
  // Clicar no card preenche o formulário; clicar num link, botão ou vídeo faz só a ação dele.
  const pickCard = (e: React.MouseEvent) => { if (!(e.target as HTMLElement).closest('a, button, video, dialog')) onPick() }
  return (
    <article className={`creation${picked ? ' picked' : ''}`} onClick={pickCard} title="Clique para gerar outra versão com estas configurações">
      <header>
        <span className="creation-title"><strong>{r.name}</strong><span className="muted">{r.prompt}</span></span>
        <div className="chips">
          <span className="chip">{r.aspect}</span>
          <span className="chip">{fmt(r.video?.durationS ?? r.targetDurationS)}</span>
          {r.tokens > 0 && <span className="chip" title="Tokens do Claude gastos neste vídeo">{compact(r.tokens)} tokens</span>}
          {r.images > 0 && <span className="chip">{r.images} {r.images === 1 ? 'imagem' : 'imagens'}</span>}
          <span className={`chip status ${r.status}`}>{STATUS[r.status]}</span>
          <span className="muted when">{ago(r.createdAt)}</span>
        </div>
      </header>
      <div className="frames">
        {working && (
          <a href={`#/projeto/${r.id}`} className={`frame working${r.status === 'failed' ? ' failed' : ''}`}>
            <span className="working-stage">{r.status === 'failed' ? 'Falhou — abrir para ver o motivo' : r.job?.status === 'paused' ? 'Pausado' : (r.job?.stage ?? STATUS[r.status])}</span>
            {r.status !== 'failed' && <span className="bar"><span style={{ width: `${r.job?.progress ?? 0}%` }} /></span>}
            {r.job?.etaS ? <span className="muted">cerca de {fmt(r.job.etaS)} restantes</span> : null}
          </a>
        )}
        {r.versions.map((v) => (
          <button key={v.version} type="button" className="frame version" onClick={() => setOpen(v.version)} aria-label={`Abrir a versão ${v.version}`}>
            <video src={`/api/projects/${r.id}/video?v=${v.version}#t=1`} preload="metadata" muted tabIndex={-1} />
            <span className="frame-play" aria-hidden="true">▶</span>
            <span className="frame-tag">Versão {v.version}{v.isCurrent ? ' · atual' : ''} · {fmt(v.durationS)}</span>
          </button>
        ))}
        {!working && !r.versions.length && <div className="frame empty" aria-hidden="true" />}
      </div>
      {open != null && (
        <Modal open onClose={() => setOpen(null)} kicker={`Versão ${open}`} title={r.name} wide>
          <video className="player" src={`/api/projects/${r.id}/video?v=${open}`} controls autoPlay />
          <footer className="modal-actions">
            <a className="btn ghost" href={`/api/projects/${r.id}/video?v=${open}&download=1`}>Baixar</a>
            <a className="btn ghost" href={`#/projeto/${r.id}`}>Andamento</a>
            <span className="spacer" />
            <a className="btn ghost" href={`#/editar/${r.id}`}>Editar</a>
            <a className="btn" href={`#/aprovar/${r.id}`}>{r.status === 'approved' ? 'Cortes' : 'Aprovar'}</a>
          </footer>
        </Modal>
      )}
    </article>
  )
}

// Quantas imagens o vídeo pede (~1 a cada 5 s). Faltando, o cliente envia mais ou completa com o banco de imagens.
function ImagesNeeded({ seconds, count, useStock, setUseStock }: { seconds: number; count: number; useStock: boolean; setUseStock: (v: boolean) => void }) {
  const need = Math.ceil(seconds / 5)
  if (count >= need) return null
  return (
    <div className="notice">
      <p>Este vídeo usa cerca de <b>{need} imagens</b>{count ? <> e você enviou {count}</> : null}. Envie mais fotos ou escolha como completar:</p>
      <div className="choice-row" role="radiogroup" aria-label="Como completar as imagens">
        <button type="button" role="radio" aria-checked={useStock} className="choice small-choice" onClick={() => setUseStock(true)}>Completar com banco de imagens</button>
        <button type="button" role="radio" aria-checked={!useStock} disabled={!count} className="choice small-choice" onClick={() => setUseStock(false)}>Repetir só as minhas</button>
      </div>
    </div>
  )
}

// Prévia de como a legenda fica no vídeo: fonte, tamanho, cor do destaque, traçado, posição e cor do fundo.
function CaptionPreview({ font, size, color, outline, position, bg }: { font: string; size: number; color: string; outline: boolean; position: string; bg: string }) {
  useEffect(() => { loadFontPreview(font) }, [font])
  const [v, h = 'center'] = position.split('-')
  return (
    <div className="cap-preview" style={{ background: bg }} aria-label="Prévia da legenda">
      <span className="cap-preview-tag">Prévia</span>
      <p className={`cap-line ${v} ${h}${outline ? '' : ' no-outline'}`} style={{ fontFamily: `"${font}"`, fontSize: `${(size / 1920) * 100}cqw` }}>
        Aqui o dia começa com <span style={{ color }}>farinha</span>
      </p>
    </div>
  )
}

// Perto do botão "Criar vídeo": quantos tokens do Claude o vídeo deve gastar, pela média dos vídeos já feitos.
function TokenEstimate({ seconds }: { seconds: number }) {
  const [est, setEst] = useState<{ tokens: number; basedOn: number } | null>(null)
  useEffect(() => { api<{ tokens: number; basedOn: number }>(`/projects/estimate?seconds=${seconds}`).then(setEst).catch(() => {}) }, [seconds])
  if (!est) return null
  return <p className="muted token-est" title={est.basedOn ? `Média dos últimos ${est.basedOn} vídeos prontos` : 'Estimativa inicial; fica mais precisa depois do primeiro vídeo'}>≈ {compact(est.tokens)} tokens do Claude</p>
}
