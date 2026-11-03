export type Segment = { startS: number; endS: number; text: string; highlights: number[] }
export type CaptionStyle = { fontFamily: string; fontWeight: number; size: number; color: string; highlightColor: string; highlightMode: string; position: 'bottom' | 'middle' }
export type TimedScene = { startS: number; endS: number; speechS: number; narration: string; onScreenText: string | null; isCard: boolean }

const WORDS_PER_LINE = 6
const norm = (w: string) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '')

// Quebra a narração de cada cena em legendas curtas, com tempo proporcional ao tamanho das palavras.
export function buildSegments(scenes: TimedScene[], mode: string, keywords: string[]): Segment[] {
  const keys = new Set(keywords.flatMap((k) => k.split(/\s+/)).map(norm).filter((k) => k.length > 2))
  const out: Segment[] = []
  for (const s of scenes) {
    const words = s.narration.split(/\s+/).filter(Boolean)
    if (!words.length) continue
    const speech = Math.min(s.speechS || s.endS - s.startS, s.endS - s.startS)
    const total = words.reduce((n, w) => n + w.length + 1, 0)
    // Linhas equilibradas (13 palavras viram 5+5+3, não 6+6+1).
    const per = Math.ceil(words.length / Math.ceil(words.length / WORDS_PER_LINE))
    let t = s.startS
    for (let i = 0; i < words.length; i += per) {
      const chunk = words.slice(i, i + per)
      const len = (chunk.reduce((n, w) => n + w.length + 1, 0) / total) * speech
      let highlights: number[] = []
      if (mode === 'karaokê') highlights = chunk.map((_, j) => j)
      else if (mode === 'palavra-chave') {
        highlights = chunk.flatMap((w, j) => (keys.has(norm(w)) ? [j] : []))
        if (!highlights.length) {
          const longest = chunk.reduce((best, w, j) => (norm(w).length > norm(chunk[best]).length ? j : best), 0)
          if (norm(chunk[longest]).length > 5) highlights = [longest]
        }
      }
      out.push({ startS: round(t), endS: round(t + len), text: chunk.join(' '), highlights })
      t += len
    }
  }
  return out
}

const round = (n: number) => Math.round(n * 100) / 100
// #RRGGBB -> &H00BBGGRR (formato de cor do ASS)
const assColor = (hex: string) => `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase()
const assTime = (s: number) => {
  const cs = Math.round(s * 100)
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, sec = Math.floor(cs / 100) % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}
const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\n/g, '\\N')

// canvas: 1920x1080 no vídeo principal, 1080x1920 nos cortes verticais.
export function toAss(segments: Segment[], scenes: TimedScene[], st: CaptionStyle, canvas = { w: 1920, h: 1080 }) {
  const vertical = canvas.h > canvas.w
  const side = vertical ? 70 : 120
  const bold = st.fontWeight >= 600 ? -1 : 0
  const align = st.position === 'middle' ? 5 : 2
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${canvas.w}`, `PlayResY: ${canvas.h}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${st.fontFamily},${st.size},${assColor(st.color)},${assColor(st.color)},&H00000000,&H80000000,${bold},0,0,0,100,100,0,0,1,4,2,${align},${side},${side},${vertical ? 380 : 90},1`,
    `Style: Card,${st.fontFamily},${Math.round(st.size * 1.5)},${assColor(st.color)},${assColor(st.color)},&H00000000,&H00000000,${bold},0,0,0,100,100,0,0,1,3,0,5,${side + 40},${side + 40},0,1`,
    `Style: Top,${st.fontFamily},${Math.round(st.size * 0.8)},${assColor(st.color)},${assColor(st.color)},&H00000000,&H80000000,${bold},0,0,0,100,100,0,0,1,3,1,8,${side},${side},${vertical ? 260 : 70},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const hl = assColor(st.highlightColor), base = assColor(st.color)
  for (const s of scenes) {
    if (!s.onScreenText) continue
    lines.push(`Dialogue: 1,${assTime(s.startS)},${assTime(s.endS)},${s.isCard ? 'Card' : 'Top'},,0,0,0,,${esc(s.onScreenText)}`)
  }
  for (const seg of segments) {
    const words = seg.text.split(' ')
    let text: string
    if (st.highlightMode === 'karaokê') {
      // \kf preenche da cor secundária (base) para a primária (destaque), palavra por palavra.
      const cs = Math.round(((seg.endS - seg.startS) * 100) / words.length)
      text = `{\\1c${hl}&\\2c${base}&}` + words.map((w) => `{\\kf${cs}}${esc(w)}`).join(' ')
    } else {
      text = words.map((w, i) => (seg.highlights.includes(i) ? `{\\1c${hl}&}${esc(w)}{\\1c${base}&}` : esc(w))).join(' ')
    }
    lines.push(`Dialogue: 0,${assTime(seg.startS)},${assTime(seg.endS)},Default,,0,0,0,,${text}`)
  }
  return lines.join('\n') + '\n'
}
