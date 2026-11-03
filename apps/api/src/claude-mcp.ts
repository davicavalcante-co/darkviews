import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { FastifyInstance } from 'fastify'
import { prisma } from '@corte/db'
import { requireAdmin } from './auth.js'

const run = promisify(execFile)
const ROOT = resolve(import.meta.dirname, '../../..')
const DESKTOP_CONFIG = join(homedir(), 'Library/Application Support/Claude/claude_desktop_config.json')
const NAME = 'corte-final'

// Como o Claude inicia o servidor MCP do Corte Final: caminhos absolutos (o app Claude não herda o PATH do terminal).
// O Homebrew guarda o Node num caminho com a versão (some na atualização); /opt/homebrew/opt/<pacote> é o atalho estável.
function nodePath() {
  const m = process.execPath.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/)
  const stable = m && `${m[1]}/opt/${m[2]}/bin/node`
  return stable && existsSync(stable) ? stable : process.execPath
}

function serverCommand(email: string) {
  return {
    command: nodePath(),
    args: [join(ROOT, 'apps/mcp/node_modules/tsx/dist/cli.mjs'), `--env-file=${join(ROOT, '.env')}`, join(ROOT, 'apps/mcp/src/index.ts')],
    env: { CORTE_FINAL_EMAIL: email },
  }
}

async function readDesktop(): Promise<Record<string, unknown> | null> {
  if (!existsSync(DESKTOP_CONFIG)) return {}
  try { return JSON.parse(await readFile(DESKTOP_CONFIG, 'utf8')) } catch { return null } // arquivo inválido: não mexemos
}

async function status() {
  const desktop = await readDesktop()
  const code = await run('claude', ['mcp', 'get', NAME], { timeout: 20_000 }).then(() => true).catch(() => false)
  return { desktop: !!(desktop?.mcpServers as Record<string, unknown> | undefined)?.[NAME], code }
}

// Um botão no Painel conecta o Corte Final ao Claude (app e Claude Code), agindo como o admin logado.
export async function claudeMcpRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireAdmin }

  app.get('/api/admin/claude/mcp', admin, async () => status())

  app.post('/api/admin/claude/mcp/connect', admin, async (req, reply) => {
    const cmd = serverCommand(req.user!.email)
    const done: string[] = []

    // App Claude: junta com o que já existe no arquivo, com cópia de segurança antes de gravar.
    const desktop = await readDesktop()
    if (desktop === null) return reply.code(409).send({ error: 'O arquivo de configuração do app Claude está com erro. Abra o app Claude uma vez e tente de novo.' })
    await mkdir(dirname(DESKTOP_CONFIG), { recursive: true })
    if (existsSync(DESKTOP_CONFIG)) await copyFile(DESKTOP_CONFIG, `${DESKTOP_CONFIG}.antes-do-corte-final`)
    const servers = (desktop.mcpServers ?? {}) as Record<string, unknown>
    await writeFile(DESKTOP_CONFIG, JSON.stringify({ ...desktop, mcpServers: { ...servers, [NAME]: cmd } }, null, 2))
    done.push('desktop')

    // Claude Code: registro no escopo do usuário (vale em qualquer pasta). Remove o antigo antes, para atualizar.
    await run('claude', ['mcp', 'remove', NAME, '--scope', 'user'], { timeout: 20_000 }).catch(() => {})
    try {
      await run('claude', ['mcp', 'add', NAME, '--scope', 'user', '-e', `CORTE_FINAL_EMAIL=${cmd.env.CORTE_FINAL_EMAIL}`, '--', cmd.command, ...cmd.args], { timeout: 30_000 })
      done.push('code')
    } catch { /* Claude Code não instalado: o app Claude já está conectado */ }

    await prisma.auditLog.create({ data: { actorId: req.user!.id, action: 'claude.mcp_connect', targetType: 'claude', targetId: null, details: JSON.stringify({ done }), ip: req.ip } })
    return { ...(await status()), restart: done.includes('desktop') }
  })

  app.post('/api/admin/claude/mcp/disconnect', admin, async (req) => {
    const desktop = await readDesktop()
    if (desktop?.mcpServers && (desktop.mcpServers as Record<string, unknown>)[NAME]) {
      const { [NAME]: _gone, ...rest } = desktop.mcpServers as Record<string, unknown>
      await writeFile(DESKTOP_CONFIG, JSON.stringify({ ...desktop, mcpServers: rest }, null, 2))
    }
    await run('claude', ['mcp', 'remove', NAME, '--scope', 'user'], { timeout: 20_000 }).catch(() => {})
    await prisma.auditLog.create({ data: { actorId: req.user!.id, action: 'claude.mcp_disconnect', targetType: 'claude', targetId: null, details: '{}', ip: req.ip } })
    return status()
  })
}
