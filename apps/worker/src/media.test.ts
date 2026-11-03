import { expect, it } from 'vitest'
import { parseSceneTimes } from './media'

it('lê os tempos de troca de cena do showinfo', () => {
  const log = '[Parsed_showinfo_1] n:0 pts:3003 pts_time:1.001 duration\n[Parsed_showinfo_1] n:1 pts:9000 pts_time:3.5 duration'
  expect(parseSceneTimes(log)).toEqual([1.001, 3.5])
})
