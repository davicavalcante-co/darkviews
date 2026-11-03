import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { logEvent } from '@corte/db'
import { askClaude } from './claude.js'

const run = promisify(execFile)
export const PROJECT_DIR = resolve(import.meta.dirname, '../../..')
const SKILL_DIR = join(PROJECT_DIR, '.claude/skills/omnivoice')
const OMNIVOICE_HOME = process.env.OMNIVOICE_HOME ?? join(homedir(), 'OmniVoice-Studio')
const API = process.env.OMNIVOICE_API_URL ?? 'http://127.0.0.1:3900'

const healthy = () => fetch(`${API}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false)

// O OmniVoice precisa do servidor local ligado. Se estiver instalado e desligado, liga com o script da própria skill.
export async function ensureOmniVoice() {
  if (await healthy()) return true
  if (!existsSync(OMNIVOICE_HOME)) return false
  try {
    await run(join(SKILL_DIR, 'scripts/start-backend.sh'), [], { env: { ...process.env, OMNIVOICE_HOME }, timeout: 120_000 })
  } catch (e) {
    logEvent({ level: 'warn', source: 'worker', kind: 'integration', message: 'omnivoice: não foi possível ligar o servidor local', details: { stderr: String((e as { stderr?: string }).stderr ?? '').slice(-1500) } })
  }
  return healthy()
}

const Result = z.object({
  voice: z.object({ profile_id: z.string().nullable(), instruct: z.string().nullable() }),
  scenes: z.array(z.object({ index: z.number().int(), file: z.string() })),
})

type Scene = { index: number; text: string }

// A narração passa pelo Claude Code: ele carrega a skill omnivoice, cria a voz que o cliente pediu e narra cada cena
// pelo MCP do OmniVoice. Os áudios ficam em arquivo dentro de `dir` (modo "files"), então o áudio não entra no contexto.
export async function narrateWithClaude(o: { jobId: string; projectId: string; scenes: Scene[]; brief: string | null; dir: string; steps: string; speed: string }) {
  const tool = (t: string) => `mcp__omnivoice__${t}`
  const out = await askClaude({
    jobId: o.jobId, cwd: PROJECT_DIR, effort: 'medium', schema: Result,
    skills: { projectDir: PROJECT_DIR, names: ['omnivoice'] },
    mcpServers: {
      omnivoice: {
        type: 'stdio', command: 'uv', args: ['--directory', OMNIVOICE_HOME, 'run', 'python', '-m', 'backend.mcp_server'],
        env: { OMNIVOICE_API_URL: API, OMNIVOICE_MCP_OUTPUT_MODE: 'files', OMNIVOICE_MCP_BASE_PATH: o.dir },
      },
    },
    allow: ['check_health', 'list_personalities', 'list_voices', 'describe_voice', 'design_voice', 'generate_speech'].map(tool),
    maxTurns: o.scenes.length * 2 + 25,
    prompt: [
      'Use a skill "omnivoice" para narrar um vídeo em português do Brasil, com as ferramentas MCP do OmniVoice.',
      '1. Chame check_health.',
      o.brief
        ? `2. O cliente pediu esta voz: "${o.brief}". Crie uma voz estável com design_voice (name: "corte-${o.projectId.slice(0, 8)}", language: "pt"), traduzindo o pedido para os atributos aceitos (use describe_voice se precisar). Se nenhum atributo servir, use list_personalities e escolha o "instruct" mais próximo.`
        : '2. O cliente não descreveu a voz: use list_personalities e escolha um narrador natural e acolhedor (use o "instruct" dele).',
      `3. Para cada cena abaixo, chame generate_speech com o texto exato, language "pt", speed ${o.speed}, steps ${o.steps}, format "wav" e a mesma voz (profile_id ou instruct) em todas as cenas, para o vídeo soar como uma pessoa só.`,
      '4. Responda com a voz usada e, para cada cena, o índice e o caminho do arquivo que generate_speech gravou. Não invente caminhos.',
      `Cenas:\n${o.scenes.map((s) => `[${s.index}] ${s.text}`).join('\n')}`,
    ].join('\n\n'),
  })
  // Só aceita arquivos que existem de verdade dentro da pasta do projeto.
  const base = realpathSync(o.dir) + sep
  const files = new Map<number, string>()
  for (const s of out.scenes) {
    try {
      const real = realpathSync(resolve(o.dir, s.file))
      if (real.startsWith(base) && o.scenes.some((x) => x.index === s.index)) files.set(s.index, real)
    } catch { /* arquivo não existe: a cena cai para a próxima voz */ }
  }
  logEvent({ source: 'worker', kind: 'integration', message: `omnivoice via Claude Code: ${files.size} de ${o.scenes.length} cenas narradas`, details: { jobId: o.jobId, voice: out.voice } })
  return files
}
