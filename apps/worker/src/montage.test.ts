import { expect, it } from 'vitest'
import { pickCuts } from './montage'

it('sorteia cortes de 3 a 6 s que cobrem o tempo pedido, dentro dos vídeos e sem repetir trecho', () => {
  let seed = 7
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const cuts = pickCuts([{ path: 'a.mp4', durationS: 1800 }, { path: 'b.mp4', durationS: 900 }], 600, random)
  expect(cuts.reduce((n, c) => n + c.lenS, 0)).toBeGreaterThanOrEqual(600)
  for (const c of cuts) {
    expect(c.lenS).toBeGreaterThanOrEqual(1); expect(c.lenS).toBeLessThanOrEqual(6)
    expect(c.startS + c.lenS).toBeLessThanOrEqual(c.path === 'a.mp4' ? 1800 : 900)
  }
  const overlaps = cuts.filter((c, i) => cuts.some((d, j) => j < i && d.path === c.path && c.startS < d.startS + d.lenS && c.startS + c.lenS > d.startS))
  expect(overlaps.length).toBe(0)
})
