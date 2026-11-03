import { expect, it } from 'vitest'
import { planCuts } from './cuts'

it('respeita o limite de cada plataforma e divide Stories em 15 s', () => {
  const cuts = planCuts({ platforms: ['shorts', 'reels', 'tiktok', 'stories'], startS: 10, endS: 200 }, 120)
  expect(cuts.filter((c) => c.platform !== 'stories')).toEqual([
    { platform: 'shorts', partIndex: 0, startS: 10, endS: 70 },
    { platform: 'reels', partIndex: 0, startS: 10, endS: 100 },
    { platform: 'tiktok', partIndex: 0, startS: 10, endS: 120 }, // corta no fim do vídeo
  ])
  const stories = cuts.filter((c) => c.platform === 'stories')
  expect(stories.map((s) => [s.startS, s.endS])).toEqual([[10, 25], [25, 40], [40, 55], [55, 70], [70, 85], [85, 100], [100, 115], [115, 120]])
})
