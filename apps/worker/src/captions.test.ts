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
    const ass = toAss(buildSegments([scene], 'palavra-chave', ['café']), [{ ...scene, onScreenText: 'Título', isCard: true }], style)
    expect(ass).toContain('{\\1c&H003BD4FF&}café{\\1c&H00FFFFFF&}')
    expect(ass).toContain('Dialogue: 1,0:00:00.00,0:00:10.00,Card,,0,0,0,,Título')
  })
})
