import { useEffect, useRef, useState } from 'react'
import { api, useFonts } from './api'

// Editor de thumbnail do YouTube: fundo (quadro do vídeo ou foto), título com palavras em destaque e um selo opcional.
// Desenhado num canvas de 1280x720 (tamanho pedido pelo YouTube) e exportado em JPG abaixo de 2 MB.
type Layout = 'left' | 'center' | 'band'
const W = 1280, H = 720
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

function wrap(ctx: CanvasRenderingContext2D, words: string[], maxW: number) {
  const lines: { word: string; i: number }[][] = [[]]
  words.forEach((word, i) => {
    const line = lines.at(-1)!
    const test = [...line.map((x) => x.word), word].join(' ')
    if (line.length && ctx.measureText(test).width > maxW) lines.push([{ word, i }]); else line.push({ word, i })
  })
  return lines
}

export function ThumbnailTab({ id, title, video }: { id: string; title: string; video: { version: number; durationS: number } | null }) {
  const fonts = useFonts()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [bg, setBg] = useState<string | null>(video ? `/api/projects/${id}/frame?t=${(video.durationS * 0.3).toFixed(1)}&v=${video.version}` : null)
  const [text, setText] = useState(title.toUpperCase())
  const [marked, setMarked] = useState<number[]>([0])
  const [tag, setTag] = useState('')
  const [font, setFont] = useState('Bebas Neue')
  const [accent, setAccent] = useState('#FFD43B')
  const [layout, setLayout] = useState<Layout>('left')
  const [saved, setSaved] = useState<{ id: string }[]>([])
  const [msg, setMsg] = useState('')
  const words = text.split(/\s+/).filter(Boolean)
  const load = () => api<{ id: string }[]>(`/projects/${id}/thumbnails`).then(setSaved).catch(() => {})
  useEffect(() => { load() }, [id])

  // Redesenha a cada mudança (espera a fonte do Google carregar para medir o texto certo).
  useEffect(() => {
    let cancel = false
    ;(async () => {
      const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}:wght@400;700;900&display=swap`
      if (!document.querySelector(`link[href="${href}"]`)) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l) }
      await document.fonts.load(`900 80px "${font}"`).catch(() => {})
      const img = bg ? await new Promise<HTMLImageElement | null>((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = bg }) : null
      const ctx = canvas.current?.getContext('2d')
      if (!ctx || cancel) return
      ctx.fillStyle = '#111418'; ctx.fillRect(0, 0, W, H)
      if (img) { const r = Math.max(W / img.width, H / img.height); ctx.drawImage(img, (W - img.width * r) / 2, (H - img.height * r) / 2, img.width * r, img.height * r) }
      // Escurece o lado do texto para dar contraste.
      const g = layout === 'band' ? ctx.createLinearGradient(0, H * 0.45, 0, H) : layout === 'left' ? ctx.createLinearGradient(0, 0, W * 0.75, 0) : ctx.createRadialGradient(W / 2, H / 2, 50, W / 2, H / 2, W * 0.7)
      g.addColorStop(0, layout === 'center' ? 'rgba(0,0,0,.25)' : 'rgba(0,0,0,.85)'); g.addColorStop(1, layout === 'center' ? 'rgba(0,0,0,.7)' : 'rgba(0,0,0,0)')
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)

      const maxW = layout === 'left' ? W * 0.58 : W * 0.86
      let size = 150
      let lines: { word: string; i: number }[][] = []
      for (; size >= 60; size -= 6) { ctx.font = `900 ${size}px "${font}"`; lines = wrap(ctx, words, maxW); if (lines.length <= 3) break }
      const lh = size * 1.02, blockH = lines.length * lh
      const top = layout === 'band' ? H - blockH - 60 : (H - blockH) / 2
      ctx.textBaseline = 'top'; ctx.lineJoin = 'round'
      lines.forEach((line, li) => {
        const full = line.map((x) => x.word).join(' ')
        let x = layout === 'left' ? 70 : (W - ctx.measureText(full).width) / 2
        for (const { word, i } of line) {
          ctx.lineWidth = size * 0.12; ctx.strokeStyle = '#000'; ctx.strokeText(word, x, top + li * lh)
          ctx.fillStyle = marked.includes(i) ? accent : '#fff'; ctx.fillText(word, x, top + li * lh)
          x += ctx.measureText(word + ' ').width
        }
      })
      if (tag.trim()) {
        ctx.font = `700 42px "${font}"`
        const tw = ctx.measureText(tag.toUpperCase()).width + 44
        const tx = layout === 'left' ? 70 : (W - tw) / 2, ty = layout === 'band' ? top - 80 : Math.max(30, top - 80)
        ctx.fillStyle = accent; ctx.fillRect(tx, ty, tw, 60)
        ctx.fillStyle = '#111'; ctx.fillText(tag.toUpperCase(), tx + 22, ty + 9)
      }
    })()
    return () => { cancel = true }
  }, [bg, text, marked, tag, font, accent, layout])

  const toJpg = () => new Promise<Blob>((ok) => canvas.current!.toBlob((b) => ok(b!), 'image/jpeg', 0.9))
  async function save() {
    setMsg('')
    try {
      const body = new FormData(); body.append('images', await toJpg(), 'thumbnail.jpg')
      await api(`/projects/${id}/thumbnails`, { method: 'POST', body })
      setMsg('Salva no projeto.'); load()
    } catch (e) { setMsg((e as Error).message) }
  }
  async function download() {
    const a = document.createElement('a'); a.href = URL.createObjectURL(await toJpg()); a.download = 'thumbnail.jpg'; a.click()
  }
  const frames = video ? Array.from({ length: 12 }, (_, i) => +((video.durationS * (i + 0.5)) / 12).toFixed(1)) : []

  return (
    <div className="cards">
      <div className="panel wide">
        <canvas ref={canvas} width={W} height={H} className="thumb-canvas" aria-label="Prévia da thumbnail" />
        <div className="row">
          <span className="muted small">1280×720 · JPG · padrão do YouTube</span>
          <span className="row">
            {msg && <span className={msg.startsWith('Salva') ? 'ok' : 'error'}>{msg}</span>}
            <button type="button" className="ghost-btn" onClick={download}>Baixar</button>
            <button type="button" onClick={save}>Salvar no projeto</button>
          </span>
        </div>
      </div>

      <div className="panel">
        <span className="panel-title">Fundo</span>
        {frames.length > 0 && (
          <div className="thumb-frames">
            {frames.map((t) => {
              const src = `/api/projects/${id}/frame?t=${t}&v=${video!.version}`
              return <button key={t} type="button" className={bg === src ? 'on' : ''} onClick={() => setBg(src)} aria-label={`Quadro em ${fmt(t)}`}><img src={src} alt="" loading="lazy" /></button>
            })}
          </div>
        )}
        <label className="btn ghost upload-btn">Usar uma foto minha
          <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setBg(URL.createObjectURL(f)); e.target.value = '' }} />
        </label>

        <span className="panel-title">Layout</span>
        <div className="choice-row" role="radiogroup" aria-label="Layout">
          {([['left', 'Texto à esquerda'], ['center', 'Centro'], ['band', 'Faixa embaixo']] as const).map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={layout === k} className="choice" onClick={() => setLayout(k)}>{l}</button>
          ))}
        </div>

        <label>Texto (curto funciona melhor: 3 a 6 palavras)<input value={text} maxLength={80} onChange={(e) => setText(e.target.value.toUpperCase())} /></label>
        <div className="words thumb-words">
          {words.map((w, i) => (
            <button key={i} type="button" aria-pressed={marked.includes(i)} style={{ color: marked.includes(i) ? accent : '#fff' }}
              onClick={() => setMarked((m) => (m.includes(i) ? m.filter((x) => x !== i) : [...m, i]))}>{w}</button>
          ))}
        </div>
        <p className="muted small">Clique nas palavras que devem ficar em destaque.</p>
        <div className="grid">
          <label>Selo (opcional)<input value={tag} maxLength={20} placeholder="Ex.: NOVO, PARTE 2" onChange={(e) => setTag(e.target.value)} /></label>
          <label>Cor do destaque<input type="color" value={accent} onChange={(e) => setAccent(e.target.value.toUpperCase())} /></label>
          <label>Fonte<select value={font} onChange={(e) => setFont(e.target.value)}>{[...new Set([font, ...fonts])].map((f) => <option key={f}>{f}</option>)}</select></label>
        </div>
      </div>

      {saved.length > 0 && (
        <div className="panel full">
          <span className="panel-title">Thumbnails salvas · {saved.length}</span>
          <div className="thumb-saved">
            {saved.map((t) => (
              <a key={t.id} href={`/api/projects/${id}/assets/${t.id}`} download="thumbnail.jpg" title="Baixar"><img src={`/api/projects/${id}/assets/${t.id}`} alt="Thumbnail salva" loading="lazy" /></a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
