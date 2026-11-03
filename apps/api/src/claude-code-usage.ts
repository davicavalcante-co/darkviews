import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// Tokens gastos no Claude Code desta máquina, lidos do histórico local (~/.claude/projects/**/*.jsonl).
// Só os números de uso de cada resposta: o conteúdo das conversas não é lido nem guardado.
export type CodeUsage = { at: Date; model: string; tokens: number }

const DAYS = 31
let cache: { at: number; rows: CodeUsage[] } | null = null

export async function claudeCodeUsage(): Promise<CodeUsage[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.rows
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  const since = Date.now() - DAYS * 86_400_000
  const seen = new Set<string>()
  const rows: CodeUsage[] = []
  const dirs = await readdir(root).catch(() => [] as string[])
  for (const d of dirs) {
    const files = await readdir(join(root, d)).catch(() => [] as string[])
    for (const f of files.filter((x) => x.endsWith('.jsonl'))) {
      const path = join(root, d, f)
      if (((await stat(path).catch(() => null))?.mtimeMs ?? 0) < since) continue
      const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
      for await (const line of lines) {
        if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
        try {
          const e = JSON.parse(line)
          const u = e.message?.usage
          const id = e.message?.id ?? e.requestId
          // A mesma resposta aparece em várias linhas (uma por bloco): conta uma vez só.
          if (e.type !== 'assistant' || !u || !id || seen.has(id)) continue
          seen.add(id)
          const at = new Date(e.timestamp)
          if (at.getTime() < since) continue
          rows.push({ at, model: e.message.model ?? 'desconhecido', tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) })
        } catch { /* linha incompleta (sessão em andamento) */ }
      }
    }
  }
  cache = { at: Date.now(), rows }
  return rows
}
