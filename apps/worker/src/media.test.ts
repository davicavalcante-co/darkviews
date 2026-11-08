import { describe, expect, it } from 'vitest'
import { parseSceneTimes } from './media'

it('lê os tempos de troca de cena do showinfo', () => {
  const log = '[Parsed_showinfo_1] n:0 pts:3003 pts_time:1.001 duration\n[Parsed_showinfo_1] n:1 pts:9000 pts_time:3.5 duration'
  expect(parseSceneTimes(log)).toEqual([1.001, 3.5])
})

describe('wordRecall (fala clara)', () => {
  it('ignora acento, pontuação e maiúsculas e cai quando faltam palavras', async () => {
    const { wordRecall } = await import('./media.js')
    expect(wordRecall('Carlo nasceu em Milão!', 'carlo nasceu em milao')).toBe(1)
    expect(wordRecall('Carlo nasceu em Milão', 'carlo em')).toBe(0.5)
    expect(wordRecall('', 'qualquer coisa')).toBe(1)
  })
})

it('narra a frase inteira e divide o áudio entre as cenas pelo texto', async () => {
  const { endsSentence, splitPoints } = await import('./media-job')
  expect(endsSentence('Talvez o almoço tenha virado um campo minado:')).toBe(false)
  expect(endsSentence('Jesus disse: “Sigam-me.”')).toBe(true)
  expect(splitPoints([10, 30], 1, 5)).toEqual([2])
  expect(splitPoints([5], 0, 3)).toEqual([])
})
