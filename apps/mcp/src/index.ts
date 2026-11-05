import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { logEvent } from '@corte/db'
import { actingUser, claudeUsage, createVideo, listProjects, projectStatus, regenerate, requestChange, ToolError, viewScript } from './tools.js'

// Servidor MCP do Darkviews: deixa o Claude (Code ou Desktop) criar e acompanhar vídeos por conversa.
// Atua como o usuário de DARKVIEWS_EMAIL, com as mesmas regras de acesso do site. stdout é só do protocolo MCP.
const server = new McpServer({ name: 'darkviews', version: '1.0.0' })
const PARTS = ['video', 'caption', 'title', 'description', 'keywords'] as const

function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (u: Awaited<ReturnType<typeof actingUser>>, a: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
  server.registerTool(name, { description, inputSchema: shape }, (async (a: z.infer<z.ZodObject<S>>) => {
    try {
      const u = await actingUser()
      const result = await fn(u, a)
      logEvent({ source: 'mcp', kind: 'request', message: `MCP ${name}`, userId: u.id })
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : e instanceof z.ZodError ? `Dados inválidos: ${e.issues.map((i) => i.message).join('; ')}` : 'Erro interno (veja Admin → Logs).'
      if (!(e instanceof ToolError) && !(e instanceof z.ZodError)) logEvent({ level: 'error', source: 'mcp', kind: 'error', message: `MCP ${name}: ${(e as Error).message}`, details: { stack: (e as Error).stack?.split('\n').slice(0, 8).join('\n') } })
      return { content: [{ type: 'text', text: msg }], isError: true }
    }
  }) as never)
}

tool('listar_projetos', 'Lista os vídeos do usuário (até 50), com status e link.', {}, (u) => listProjects(u))
tool('criar_video', 'Cria um vídeo a partir de um prompt. Opcional: link de referência (YouTube, Instagram, Kwai ou TikTok) e a voz desejada (ex.: "mulher jovem, animada").', {
  nome: z.string().describe('Nome do projeto'),
  prompt: z.string().describe('Sobre o que é o vídeo, público, tom e chamada para ação'),
  duracao_minutos: z.number().min(0.25).max(18).describe('Duração em minutos (até 18)'),
  link_referencia: z.string().optional(),
  voz_desejada: z.string().max(200).optional(),
}, (u, a) => createVideo(u, a))
tool('status_projeto', 'Mostra em que etapa um vídeo está, o progresso e o tempo restante.', { id: z.string() }, (u, a) => projectStatus(u, a.id))
tool('ver_roteiro', 'Mostra título, descrição, palavras-chave, roteiro e cenas de um vídeo.', { id: z.string() }, (u, a) => viewScript(u, a.id))
tool('pedir_alteracao', 'Registra um pedido de alteração numa parte do vídeo. Para o vídeo, informe o segundo do quadro.', {
  id: z.string(), parte: z.enum(PARTS), texto: z.string().min(1).max(1000), tempo_segundos: z.number().min(0).optional(),
}, (u, a) => requestChange(u, a))
tool('regerar_parte', 'Regera uma parte do vídeo com o Claude, aplicando os pedidos de alteração abertos.', { id: z.string(), parte: z.enum(PARTS) }, (u, a) => regenerate(u, a))
tool('uso_claude', 'Mostra se o Claude está disponível, os avisos e (para admin) os limites do plano.', {}, (u) => claudeUsage(u))

await server.connect(new StdioServerTransport())
