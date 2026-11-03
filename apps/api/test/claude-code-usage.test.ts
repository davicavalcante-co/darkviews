import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('tokens do Claude Code', () => {
  it('soma o uso do histórico local, conta cada resposta uma vez e ignora o resto', async () => {
    const dir = join(tmpdir(), `cc-${Date.now()}`)
    mkdirSync(join(dir, 'projects', 'proj'), { recursive: true })
    const now = new Date().toISOString()
    const msg = (id: string, input: number, out: number) => JSON.stringify({ type: 'assistant', timestamp: now, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: out, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } } })
    writeFileSync(join(dir, 'projects', 'proj', 's.jsonl'), [
      msg('a', 100, 50), msg('a', 100, 50), // mesma resposta em duas linhas
      msg('b', 1, 1),
      JSON.stringify({ type: 'user', timestamp: now, message: { content: 'texto da conversa com "usage" no meio' } }),
      '{"type":"assistant","usage"', // linha cortada (sessão em andamento)
    ].join("\n"))
    process.env.CLAUDE_CONFIG_DIR = dir
    const { claudeCodeUsage } = await import('../src/claude-code-usage.js')
    const rows = await claudeCodeUsage()
    expect(rows.map((r) => r.tokens)).toEqual([160, 12])
    expect(rows[0].model).toBe('claude-opus-5-5')
  })
})
