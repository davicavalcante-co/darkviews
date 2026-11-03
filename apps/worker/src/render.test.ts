import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSegments, toAss } from './captions'
import { durationOf, FFMPEG, run } from './ffmpeg'
import { renderVideo } from './render'

describe('render', () => {
  it('monta foto (Ken Burns) + quadro de texto, com locução e legenda, em 1920x1080', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'corte-teste-'))
    const img = join(dir, 'foto.png'), voice = join(dir, 'voz.wav'), out = join(dir, 'final.mp4')
    await run(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720', '-frames:v', '1', img])
    await run(FFMPEG, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', voice])
    const timed = [
      { startS: 0, endS: 2, speechS: 1.5, narration: 'Primeira cena com foto', onScreenText: null, isCard: false },
      { startS: 2, endS: 3.5, speechS: 0, narration: '', onScreenText: 'Quadro de texto', isCard: true },
    ]
    const style = { fontFamily: 'Helvetica', fontWeight: 700, size: 64, color: '#FFFFFF', highlightColor: '#FFD43B', highlightMode: 'palavra-chave', position: 'bottom' as const }
    await renderVideo({
      scenes: [
        { durationS: 2, kind: 'image', path: img, transition: 'fade', voice },
        { durationS: 1.5, kind: 'card', transition: 'cut', voice: null },
      ],
      music: null, ass: toAss(buildSegments(timed, 'palavra-chave', []), timed, style), fontsDir: dir, out,
    })
    expect(await durationOf(out)).toBeCloseTo(3.5, 0)
    const { stdout } = await run(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', out])
    expect(stdout.trim()).toBe('1920,1080,30/1')
  }, 60_000)
})
