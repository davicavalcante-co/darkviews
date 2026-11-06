import { describe, expect, it } from 'vitest'
import { buildSegments, toAss, type TimedScene } from './captions'

const scene: TimedScene = { startS: 0, endS: 10, speechS: 8, narration: 'O café especial muda a manhã de quem acorda cedo todos os dias', onScreenText: null, isCard: false }
const style = { fontFamily: 'Inter', fontWeight: 700, size: 64, color: '#FFFFFF', highlightColor: '#FFD43B', highlightMode: 'palavra-chave', position: 'bottom' as const }

describe('legendas', () => {
  it('divide em linhas de até 6 palavras dentro do tempo de fala', () => {
    const segs = buildSegments([scene], 'manual', [])
    expect(segs.map((s) => s.text.split(' ').length)).toEqual([5, 5, 3])
    expect(segs[0].startS).toBe(0)
    expect(segs.at(-1)!.endS).toBeCloseTo(8, 1)
  })
  it('destaca palavras-chave sem acento/caixa', () => {
    const segs = buildSegments([scene], 'palavra-chave', ['Cafe'])
    expect(segs[0].highlights).toEqual([1])
  })
  it('posição vira o alinhamento do ASS (vertical + horizontal)', () => {
    const alignOf = (position: string) => toAss([], [], { ...style, position }).split('\n').find((l) => l.startsWith('Style: Default'))!.split(',')[18]
    expect([alignOf('bottom'), alignOf('bottom-left'), alignOf('middle'), alignOf('top-right')]).toEqual(['2', '1', '5', '9'])
  })

  it('gera ASS com cor no formato BGR e tempos corretos', () => {
    const ass = toAss(buildSegments([scene], 'palavra-chave', ['café']), [{ ...scene, onScreenText: 'Título', isCard: false }], style)
    expect(ass).toContain('{\\1c&H003BD4FF&}café{\\1c&H00FFFFFF&}')
    expect(ass).toMatch(/Dialogue: 1,0:00:00\.15,0:00:02\.95,Top,.*TÍTULO/) // destaque some depois de ~2,8 s
  })

  it('legenda aplicada depois: só a fala, sem repetir títulos que já estão no vídeo base', () => {
    const ass = toAss(buildSegments([scene], 'palavra-chave', []), [{ ...scene, onScreenText: 'Título', isCard: false }], style, undefined, false)
    expect(ass).toMatch(/Default,/)
    expect(ass).not.toContain('TÍTULO')
    expect(toAss([], [{ ...scene, onScreenText: 'Título', isCard: false }], style)).not.toMatch(/Dialogue: 0,/) // vídeo base: títulos sem fala
  })

  it('cartela de capítulo: título grande em caixa alta e sem a legenda da fala por cima', () => {
    const ass = toAss(buildSegments([scene], 'palavra-chave', []), [{ ...scene, onScreenText: 'Fora de campo', isCard: true }], style)
    expect(ass).toContain('Card,,0,0,0,,{\\fad(250,200)}FORA DE CAMPO')
    expect(ass).not.toMatch(/Dialogue: 0,.*Default/)
  })
})

describe('legenda presa à fala', () => {
  const scene = (startS: number, endS: number, narration: string, speech?: [number, number]) =>
    ({ startS, endS, speechS: endS - startS, narration, onScreenText: null, isCard: false, ...(speech && { speechStartS: speech[0], speechEndS: speech[1] }) })

  it('começa e termina onde a fala realmente acontece', async () => {
    const { buildSegments } = await import('./captions')
    const segs = buildSegments([scene(0, 6, 'Em Assis tudo começou', [3, 5])], 'manual', [])
    expect(segs[0].startS).toBe(3)
    expect(segs.at(-1)!.endS).toBe(5)
  })

  it('refaz os tempos da legenda editada quando as cenas mudam de lugar, mantendo o texto', async () => {
    const { retimeSegments } = await import('./captions')
    const old = [{ startS: 0, endS: 2, text: 'Primeira fala aqui', highlights: [] }, { startS: 2, endS: 4, text: 'Segunda fala', highlights: [1] }]
    const moved = retimeSegments(old, [scene(10, 13, 'primeira fala aqui'), scene(13, 15, 'segunda fala')])
    expect(moved.map((s) => [s.text, s.startS, s.endS])).toEqual([['Primeira fala aqui', 10, 13], ['Segunda fala', 13, 15]])
    expect(moved[1].highlights).toEqual([1])
    // Texto com outro número de palavras: não dá para ligar às cenas, mantém os tempos
    expect(retimeSegments(old, [scene(10, 15, 'outra coisa')])).toBe(old)
  })

  it('mede onde a fala começa e termina no áudio', async () => {
    const { speechBounds } = await import('./render')
    const { FFMPEG, run } = await import('./ffmpeg')
    const { mkdtemp } = await import('node:fs/promises')
    const dir = await mkdtemp((await import('node:os')).tmpdir() + '/fala-')
    const f = dir + '/f.wav'
    await run(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-af', 'adelay=1000:all=1,apad=pad_dur=0.5', f])
    const [on, off] = await speechBounds(f)
    expect(on).toBeCloseTo(1, 1)
    expect(off).toBeCloseTo(3, 1)
  })
})
