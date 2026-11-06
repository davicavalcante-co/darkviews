import { expect, it } from 'vitest'
import { planCuts } from './cuts'

it('divide o trecho em cortes seguidos no limite de cada plataforma', () => {
  const cuts = planCuts({ platforms: ['shorts', 'tiktok', 'stories'], startS: 10, endS: 200 }, 120)
  const of = (p: string) => cuts.filter((c) => c.platform === p).map((c) => [c.startS, c.endS])
  expect(of('shorts')).toEqual([[10, 70], [70, 120]])
  expect(of('tiktok')).toEqual([[10, 120]]) // corta no fim do vídeo
  expect(of('stories')).toEqual([[10, 25], [25, 40], [40, 55], [55, 70], [70, 85], [85, 100], [100, 115], [115, 120]])
})

it('usa a duração escolhida (4 min em 4 de 1 min) e junta sobra pequena no anterior', () => {
  const four = planCuts({ platforms: ['reels'], startS: 0, endS: 240, partS: 60 }, 240)
  expect(four.map((c) => [c.partIndex, c.startS, c.endS])).toEqual([[0, 0, 60], [1, 60, 120], [2, 120, 180], [3, 180, 240]])
  expect(planCuts({ platforms: ['reels'], startS: 0, endS: 62, partS: 60 }, 62).map((c) => [c.startS, c.endS])).toEqual([[0, 62]])
  expect(planCuts({ platforms: ['shorts'], startS: 0, endS: 300, partS: 120 }, 300)[0].endS).toBe(60) // nunca passa do limite do Shorts
})
