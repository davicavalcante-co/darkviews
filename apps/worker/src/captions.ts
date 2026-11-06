export type Segment = { startS: number; endS: number; text: string; highlights: number[] }
export type CaptionStyle = { fontFamily: string; fontWeight: number; size: number; color: string; highlightColor: string; highlightMode: string; position: string; outline?: boolean }
// speechStartS/speechEndS: onde a fala realmente começa e termina (medido no áudio), sem a pausa de entrada e de saída.
export type TimedScene = { startS: number; endS: number; speechS: number; narration: string; onScreenText: string | null; isCard: boolean; speechStartS?: number; speechEndS?: number }

// Cor da faixa de destaque no formato do ASS (&HAABBGGRR, opaca).
const hlBox = (hex: string) => `&H00${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`

const WORDS_PER_LINE = 6
const norm = (w: string) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '')

const wordsOf = (t: string) => t.split(/\s+/).filter(Boolean)
// Janela da fala na cena: medida no áudio quando há; senão a cena toda.
const speechWindow = (s: TimedScene) => {
  const start = s.speechStartS ?? s.startS
  const end = s.speechEndS ?? s.startS + Math.min(s.speechS || s.endS - s.startS, s.endS - s.startS)
  return [start, Math.max(start + 0.1, end)] as const
}
// Espalha as linhas de uma cena pela janela da fala, proporcional ao tamanho das palavras.
function place(lines: { text: string; highlights: number[] }[], s: TimedScene): Segment[] {
  const [start, end] = speechWindow(s)
  const size = (t: string) => wordsOf(t).reduce((n, w) => n + w.length + 1, 0)
  const total = lines.reduce((n, l) => n + size(l.text), 0) || 1
  let t = start
  return lines.map((l) => { const len = (size(l.text) / total) * (end - start); const seg = { ...l, startS: round(t), endS: round(t + len) }; t += len; return seg })
}

// Quebra a narração de cada cena em legendas curtas, presas ao tempo da fala.
export function buildSegments(scenes: TimedScene[], mode: string, keywords: string[]): Segment[] {
  const keys = new Set(keywords.flatMap((k) => k.split(/\s+/)).map(norm).filter((k) => k.length > 2))
  const out: Segment[] = []
  for (const s of scenes) {
    const words = wordsOf(s.narration)
    if (!words.length) continue
    // Linhas equilibradas (13 palavras viram 5+5+3, não 6+6+1).
    const per = Math.ceil(words.length / Math.ceil(words.length / WORDS_PER_LINE))
    const lines: { text: string; highlights: number[] }[] = []
    for (let i = 0; i < words.length; i += per) {
      const chunk = words.slice(i, i + per)
      let highlights: number[] = []
      if (mode === 'karaokê') highlights = chunk.map((_, j) => j)
      else if (mode === 'palavra-chave') {
        highlights = chunk.flatMap((w, j) => (keys.has(norm(w)) ? [j] : []))
        if (!highlights.length) {
          const longest = chunk.reduce((best, w, j) => (norm(w).length > norm(chunk[best]).length ? j : best), 0)
          if (norm(chunk[longest]).length > 5) highlights = [longest]
        }
      }
      lines.push({ text: chunk.join(' '), highlights })
    }
    out.push(...place(lines, s))
  }
  return out
}

// Legenda já existente (talvez editada): mantém o texto e refaz os tempos pela fala atual de cada cena,
// para nunca ficar adiantada ou atrasada (ex.: depois de mudar a duração das cartelas). As linhas são ligadas às cenas
// pela ordem das palavras; se o texto mudou demais para isso (outro número de palavras), mantém os tempos.
export function retimeSegments(segments: Segment[], scenes: TimedScene[]): Segment[] {
  const spoken = scenes.filter((s) => wordsOf(s.narration).length)
  const need = spoken.map((s) => wordsOf(s.narration).length)
  if (need.reduce((a, b) => a + b, 0) !== segments.reduce((n, g) => n + wordsOf(g.text).length, 0)) return segments
  const out: Segment[] = []
  let k = 0
  for (const [i, s] of spoken.entries()) {
    const lines: Segment[] = []
    let left = need[i]
    while (left > 0 && k < segments.length) { lines.push(segments[k]); left -= wordsOf(segments[k].text).length; k++ }
    if (left !== 0) return segments // uma linha atravessa duas cenas: não dá para ligar com certeza
    out.push(...place(lines, s))
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
// Estilo dos enunciados (cartelas de capítulo e faixas de destaque), separado da legenda. Vale para todos os enunciados.
// cardAlign/bandAlign: "vertical-horizontal" (ex.: "middle-center", "top-left"). upper: caixa alta (padrão sim).
export type TitleStyle = { fontFamily: string; size: number; color: string; bandColor: string; bandSize?: number; cardAlign?: string; bandAlign?: string; upper?: boolean }
// Alinhamento do ASS no teclado numérico: embaixo 1-3, meio 4-6, em cima 7-9; esquerda, centro, direita.
const numpad = (pos: string, fallback: number) => {
  const [v, h = 'center'] = pos.split('-')
  const row = ({ bottom: 1, middle: 4, top: 7 } as Record<string, number>)[v], col = ({ left: 0, center: 1, right: 2 } as Record<string, number>)[h]
  return row === undefined || col === undefined ? fallback : row + col
}

// overlays=false: só a legenda da fala (as cartelas e destaques já estão no vídeo base).
export function toAss(segments: Segment[], scenes: TimedScene[], st: CaptionStyle, canvas = { w: 1920, h: 1080 }, overlays = true, title?: TitleStyle) {
  const ts = title ?? { fontFamily: st.fontFamily, size: Math.round(st.size * 2.4), color: '#FFFFFF', bandColor: st.highlightColor }
  const cardAlign = numpad(ts.cardAlign ?? 'middle-center', 5), bandAlign = numpad(ts.bandAlign ?? 'top-left', 7)
  const bandSize = ts.bandSize ?? Math.round(ts.size * 0.4)
  const shout = (t: string) => (ts.upper === false ? t : t.toUpperCase())
  const vertical = canvas.h > canvas.w
  const side = vertical ? 70 : 120
  const bold = st.fontWeight >= 600 ? -1 : 0
  // Alinhamento do ASS no teclado numérico: embaixo 1-3, meio 4-6, em cima 7-9; esquerda, centro, direita.
  const [v, h = 'center'] = st.position.split('-')
  const align = ({ bottom: 1, middle: 4, top: 7 }[v] ?? 1) + ({ left: 0, center: 1, right: 2 }[h] ?? 1)
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${canvas.w}`, `PlayResY: ${canvas.h}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${st.fontFamily},${st.size},${assColor(st.color)},${assColor(st.color)},&H00000000,&H80000000,${bold},0,0,0,100,100,0,0,1,${st.outline === false ? '0,1' : '4,2'},${align},${side},${side},${vertical ? 380 : 90},1`,
    // Cartela de capítulo (estilo das referências de YouTube): título enorme, caixa alta, condensado, com sombra.
    `Style: Card,${ts.fontFamily},${ts.size},${assColor(ts.color)},${assColor(ts.color)},&H00000000,&H64000000,-1,0,0,0,96,100,1,0,1,0,6,${cardAlign},${side + 60},${side + 60},${vertical ? 300 : 120},1`,
    // Texto de destaque sobre a imagem: faixa na cor de destaque (caixa opaca), texto escuro, no alto à esquerda.
    `Style: Top,${ts.fontFamily},${bandSize},&H00111111,&H00111111,${hlBox(ts.bandColor)},${hlBox(ts.bandColor)},-1,0,0,0,100,100,1,0,3,14,0,${bandAlign},${side},${side},${vertical ? 260 : 80},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const hl = assColor(st.highlightColor), base = assColor(st.color)
  for (const s of overlays ? scenes : []) {
    if (!s.onScreenText) continue
    const text = esc(shout(s.onScreenText))
    if (s.isCard) lines.push(`Dialogue: 1,${assTime(s.startS)},${assTime(s.endS)},Card,,0,0,0,,{\\fad(250,200)}${text}`)
    // Sobre a imagem, o destaque entra (deslizando, quando fica no alto à esquerda) e fica só 2,8 s.
    else lines.push(`Dialogue: 1,${assTime(s.startS + 0.15)},${assTime(Math.min(s.endS, s.startS + 2.95))},Top,,0,0,0,,{\\fad(180,220)${bandAlign === 7 ? `\\move(${side - 60},${vertical ? 260 : 80},${side},${vertical ? 260 : 80},0,220)` : ''}}${text}`)
  }
  // Na cartela de capítulo não entra a legenda da fala: o título já ocupa a tela.
  segments = segments.filter((g) => !scenes.some((s) => s.isCard && s.onScreenText && g.startS >= s.startS && g.endS <= s.endS + 0.05))
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
