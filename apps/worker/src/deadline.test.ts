import { describe, expect, it, vi } from 'vitest'
import { deadline } from './deadline.js'

describe('deadline', () => {
  it('devolve o resultado dentro do prazo e falha com mensagem clara depois dele', async () => {
    expect(await deadline(Promise.resolve(7), 1)).toBe(7)
    vi.useFakeTimers()
    const late = deadline(new Promise(() => {}), 2)
    vi.advanceTimersByTime(2 * 60_000)
    await expect(late).rejects.toThrow('Demorou mais de 2 min')
    vi.useRealTimers()
  })
})
