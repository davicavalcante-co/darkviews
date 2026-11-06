import { describe, expect, it } from 'vitest'
import { checkPlan, type ScriptOutput } from './plan'

const scene = (startS: number, endS: number, imageIndex = 0) => ({
  startS, endS, narration: 'x', onScreenText: '', transition: 'cut' as const, media: { type: 'user_image' as const, imageIndex },
})
const plan = (scenes: ReturnType<typeof scene>[]): ScriptOutput => ({ title: 't', description: 'd', keywords: ['a', 'b', 'c'], body: 'b', scenes })

describe('checkPlan', () => {
  it('aceita um plano contínuo na duração certa', () => {
    expect(checkPlan(plan([scene(0, 30), scene(30, 60)]), 60, 1)).toEqual([])
  })
  it('acusa buraco entre cenas, imagem inexistente, duração errada e passar de 60 min', () => {
    expect(checkPlan(plan([scene(0, 30), scene(32, 60)]), 60, 1)[0]).toMatch(/Cena 2/)
    expect(checkPlan(plan([scene(0, 60, 3)]), 60, 1)[0]).toMatch(/imagem 3/)
    expect(checkPlan(plan([scene(0, 20)]), 60, 1)[0]).toMatch(/longe/)
    expect(checkPlan(plan([scene(0, 3700)]), 3600, 1)[0]).toMatch(/60 minutos/)
  })
})
