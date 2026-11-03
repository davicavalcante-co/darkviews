import { query, type SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk'
import type { ZodType } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { prisma } from '@corte/db'
import type { ClaudeReason } from '@corte/shared'

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-5-5'

// Claude fora do ar ou no limite: o worker pausa o job e o retoma em `resumeAt`.
export class ClaudeUnavailable extends Error {
  constructor(message: string, readonly resumeAt: Date, readonly reason: ClaudeReason) { super(message) }
}

type StatusPatch = { available: boolean; reason: ClaudeReason; sessionUsedPct?: number | null; sessionResetsAt?: Date | null; weekUsedPct?: number | null; weekResetsAt?: Date | null }

// Novo retrato do status (claude_status), mantendo os percentuais que este evento não trouxe.
export async function recordStatus(patch: StatusPatch) {
  const last = await prisma.claudeStatus.findFirst({ orderBy: { checkedAt: 'desc' } })
  await prisma.claudeStatus.create({
    data: {
      sessionUsedPct: last?.sessionUsedPct, sessionResetsAt: last?.sessionResetsAt,
      weekUsedPct: last?.weekUsedPct, weekResetsAt: last?.weekResetsAt, ...patch,
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

type Ask<T> = { jobId: string; prompt: string; schema: ZodType<T>; cwd: string; canReadFiles?: boolean; effort?: 'low' | 'medium' | 'high' }

// Uma chamada ao Claude local (login do Claude Code da máquina) com saída JSON validada.
export async function askClaude<T>({ jobId, prompt, schema, cwd, canReadFiles, effort = 'high' }: Ask<T>): Promise<T> {
  let limit: SDKRateLimitInfo | null = null
  const run = query({
    prompt,
    options: {
      model: MODEL,
      cwd,
      effort,
      tools: canReadFiles ? ['Read'] : [],
      allowedTools: canReadFiles ? ['Read'] : [],
      maxTurns: 30,
      settingSources: [], // não carrega CLAUDE.md nem configurações do usuário
      persistSession: false,
      outputFormat: { type: 'json_schema', schema: zodToJsonSchema(schema, { $refStrategy: 'none' }) as Record<string, unknown> },
    },
  })

  for await (const msg of run) {
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
            jobId, model, inputTokens: u.inputTokens, outputTokens: u.outputTokens,
            cacheReadTokens: u.cacheReadInputTokens, cacheWriteTokens: u.cacheCreationInputTokens,
          },
        })
      }
      if (msg.subtype !== 'success') throw new Error(`Claude não concluiu (${msg.subtype})`)
      const parsed = schema.safeParse(msg.structured_output)
      if (!parsed.success) throw new Error('Claude devolveu JSON fora do formato: ' + parsed.error.issues[0]?.message)
      return parsed.data
    }
  }
  throw new Error('Claude encerrou sem resultado')
}
