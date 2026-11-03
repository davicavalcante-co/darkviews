import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toAss } from './captions'
import { cropXpx, renderCut, shiftToWindow } from './cuts'
import { durationOf, FFMPEG, run } from './ffmpeg'

describe('cortes verticais', () => {
  it('posição da janela 9:16 vai da esquerda (0) à direita (100)', () => {
    expect([cropXpx(0), cropXpx(50), cropXpx(100)]).toEqual([0, 656, 1312])
  })

  it('desloca legendas para o trecho e descarta o que fica fora', () => {
    const segs = [{ startS: 0, endS: 2, text: 'fora', highlights: [] }, { startS: 9, endS: 12, text: 'borda', highlights: [] }, { startS: 12, endS: 14, text: 'dentro', highlights: [] }]
    const w = shiftToWindow(segs, [], 10, 20)
    expect(w.segments.map((s) => [s.text, s.startS, s.endS])).toEqual([['borda', 0, 2], ['dentro', 2, 4]])
  })

  it('gera MP4 1080x1920 com a duração do trecho', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'corte-teste-'))
    const clean = join(dir, 'limpo.mp4'), out = join(dir, 'shorts.mp4')
    await run(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=duration=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clean])
    const style = { fontFamily: 'Helvetica', fontWeight: 700, size: 64, color: '#FFFFFF', highlightColor: '#FFD43B', highlightMode: 'manual', position: 'bottom' as const }
    await renderCut({ clean, startS: 1, endS: 4, cropX: 30, fontsDir: dir, out,
      ass: toAss([{ startS: 0, endS: 3, text: 'Legenda vertical', highlights: [] }], [], style, { w: 1080, h: 1920 }) })
    expect(await durationOf(out)).toBeCloseTo(3, 0)
    const { stdout } = await run(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out])
    expect(stdout.trim()).toBe('1080,1920')
  }, 60_000)
})
