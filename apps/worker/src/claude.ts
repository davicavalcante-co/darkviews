import { query, type McpServerConfig, type SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import type { ZodType } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { logEvent, prisma } from '@corte/db'
import type { ClaudeReason } from '@corte/shared'

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-5-5'
export const LIGHT_MODEL = process.env.CLAUDE_LIGHT_MODEL ?? 'claude-haiku-5-5'

// Claude fora do ar ou no limite: o worker pausa o job e o retoma em `resumeAt`.
export class ClaudeUnavailable extends Error {
  constructor(message: string, readonly resumeAt: Date, readonly reason: ClaudeReason) { super(message) }
}

type StatusPatch = { available: boolean; reason: ClaudeReason; sessionUsedPct?: number | null; sessionResetsAt?: Date | null; weekUsedPct?: number | null; weekResetsAt?: Date | null; subscriptionType?: string | null }

// Novo retrato do status (claude_status), mantendo os percentuais que este evento não trouxe.
export async function recordStatus(patch: StatusPatch) {
  const last = await prisma.claudeStatus.findFirst({ orderBy: { checkedAt: 'desc' } })
  await prisma.claudeStatus.create({
    data: {
      sessionUsedPct: last?.sessionUsedPct, sessionResetsAt: last?.sessionResetsAt,
      weekUsedPct: last?.weekUsedPct, weekResetsAt: last?.weekResetsAt, subscriptionType: last?.subscriptionType, ...patch,
    },
  })
}

async function saveRateLimit(info: SDKRateLimitInfo) {
  const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000) : null
  const pct = info.utilization == null ? null : info.utilization * (info.utilization <= 1 ? 100 : 1)
  await recordStatus({
    available: info.status !== 'rejected',
    reason: info.status === 'rejected' ? 'rate_limit' : null,
    ...(info.rateLimitType === 'five_hour' && { sessionUsedPct: pct, sessionResetsAt: resetsAt }),
    ...(info.rateLimitType?.startsWith('seven_day') && { weekUsedPct: pct, weekResetsAt: resetsAt }),
  })
}

type Ask<T> = {
  jobId: string; prompt: string; schema: ZodType<T>; cwd: string; canReadFiles?: boolean; effort?: 'low' | 'medium' | 'high'
  // Skills do projeto (.claude/skills) + servidores MCP: o Claude Code usa só as ferramentas listadas em `allow`.
  skills?: { projectDir: string; names: string[] }; mcpServers?: Record<string, McpServerConfig>; allow?: string[]; maxTurns?: number
  model?: string // tarefas simples (escolher entre opções) usam um modelo menor e mais barato
}

// Uma chamada ao Claude local (login do Claude Code da máquina) com saída JSON validada.
export async function askClaude<T>({ jobId, prompt, schema, cwd, canReadFiles, effort = 'high', skills, mcpServers, allow = [], maxTurns = 30, model = MODEL }: Ask<T>): Promise<T> {
  const builtIn = [...(canReadFiles ? ['Read'] : []), ...(skills ? ['Skill'] : [])]
  let limit: SDKRateLimitInfo | null = null
  const run = query({
    prompt,
    options: {
      model,
      cwd: skills?.projectDir ?? cwd,
      effort,
      tools: builtIn,
      allowedTools: [...builtIn, ...allow],
      // Só os servidores MCP passados aqui (ignora .mcp.json, conectores e configurações do usuário) e só as skills pedidas.
      ...(mcpServers && { mcpServers, strictMcpConfig: true }),
      ...(skills && { skills: skills.names }),
      maxTurns,
      // Sem skills: não carrega nada do usuário. Com skills: só as do projeto (.claude/skills), nunca as configurações pessoais.
      settingSources: skills ? ['project'] : [],
      persistSession: false,
      outputFormat: { type: 'json_schema', schema: zodToJsonSchema(schema, { $refStrategy: 'none' }) as Record<string, unknown> },
    },
  })

  for await (const msg of run) {
    // Servidor MCP que não conectou vira aviso nos logs (senão o Claude responde sem as ferramentas).
    if (msg.type === 'system' && msg.subtype === 'init' && mcpServers) {
      const bad = msg.mcp_servers.filter((s) => s.status !== 'connected')
      logEvent({ level: bad.length ? 'warn' : 'info', source: 'worker', kind: 'claude', message: bad.length ? `MCP sem conexão: ${bad.map((s) => `${s.name} (${s.status})`).join(', ')}` : `MCP conectado: ${msg.mcp_servers.map((s) => s.name).join(', ')}`,
        details: { jobId, servers: msg.mcp_servers, tools: msg.tools.filter((t) => t.startsWith('mcp__') || t === 'Skill'), skills: (msg as { skills?: unknown }).skills } })
    }
    // Erro devolvido por uma ferramenta (ex.: generate_speech) vai para os logs, para dar para entender o que falhou.
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      for (const b of msg.message.content as { type: string; is_error?: boolean; content?: unknown }[]) {
        if (b.type === 'tool_result' && b.is_error) logEvent({ level: 'warn', source: 'worker', kind: 'claude', message: 'ferramenta devolveu erro', details: { jobId, erro: JSON.stringify(b.content).slice(0, 1500) } })
      }
    }
    if (msg.type === 'rate_limit_event') {
      limit = msg.rate_limit_info
      await saveRateLimit(limit)
    }
    if (msg.type === 'assistant' && msg.error) {
      if (msg.error === 'rate_limit') {
        const at = limit?.resetsAt ? new Date(limit.resetsAt * 1000) : new Date(Date.now() + 15 * 60_000)
        throw new ClaudeUnavailable(`Claude indisponível até ${at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} (limite)`, at, 'rate_limit')
      }
      if (msg.error === 'overloaded' || msg.error === 'server_error') {
        throw new ClaudeUnavailable('Claude sobrecarregado. Nova tentativa em 1 min.', new Date(Date.now() + 60_000), 'overloaded')
      }
      if (msg.error === 'authentication_failed') {
        throw new ClaudeUnavailable('Faça login no Claude Code neste computador.', new Date(Date.now() + 5 * 60_000), 'no_login')
      }
    }
    if (msg.type === 'result') {
      for (const [model, u] of Object.entries(msg.modelUsage ?? {})) {
        await prisma.claudeUsageEvent.create({
          data: {
            jobId: jobId || null, model, inputTokens: u.inputTokens, outputTokens: u.outputTokens,
            cacheReadTokens: u.cacheReadInputTokens, cacheWriteTokens: u.cacheCreationInputTokens,
          },
        })
      }
      logEvent({ level: msg.subtype === 'success' ? 'info' : 'error', source: 'worker', kind: 'claude', message: `chamada ao Claude: ${msg.subtype}`,
        details: { jobId, durationMs: msg.duration_ms, models: Object.fromEntries(Object.entries(msg.modelUsage ?? {}).map(([m, u]) => [m, { in: u.inputTokens, out: u.outputTokens }])) } })
      if (msg.subtype !== 'success') throw new Error(`Claude não concluiu (${msg.subtype})`)
      const parsed = schema.safeParse(msg.structured_output)
      if (!parsed.success) throw new Error('Claude devolveu JSON fora do formato: ' + parsed.error.issues[0]?.message)
      return parsed.data
    }
  }
  throw new Error('Claude encerrou sem resultado')
}

// Uso real do plano (o mesmo do /usage do Claude Code): percentuais e horários de reinício das janelas de 5 h e 7 dias.
// Não envia mensagem nenhuma, então não gasta tokens.
// shortcut: API marcada como EXPERIMENTAL no Agent SDK; se mudar de nome, o Painel volta a usar só os eventos de rate limit dos jobs.
export async function readPlanUsage() {
  let release!: () => void
  const done = new Promise<void>((r) => { release = r })
  // Entrada em streaming que não manda nada: abre a sessão só para a consulta de controle.
  async function* idle() { await done }
  const q = query({ prompt: idle() as AsyncIterable<never>, options: { model: MODEL, tools: [], settingSources: [], persistSession: false } })
  const drain = (async () => { try { for await (const _ of q) { /* sem mensagens */ } } catch { /* sessão encerrada */ } })()
  try {
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
    const five = u.rate_limits?.five_hour, week = u.rate_limits?.seven_day
    return {
      subscriptionType: u.subscription_type,
      available: u.rate_limits_available,
      sessionUsedPct: five?.utilization ?? null, sessionResetsAt: five?.resets_at ? new Date(five.resets_at) : null,
      weekUsedPct: week?.utilization ?? null, weekResetsAt: week?.resets_at ? new Date(week.resets_at) : null,
    }
  } finally {
    release()
    await Promise.race([drain, new Promise((r) => setTimeout(r, 5000))])
  }
}
