import { prisma, type User } from '@corte/db'
import { claudeWarnings, DEFAULT_FONTS, DEFAULT_SETTINGS, MAX_DURATION_S, NewProjectInput, Part } from '@corte/shared'

// Regras iguais às da API: usuário comum só mexe nos próprios projetos (o resto "não existe"); admin vê todos.
export class ToolError extends Error {}

export async function actingUser(email = process.env.CORTE_FINAL_EMAIL): Promise<User> {
  if (!email) throw new ToolError('Defina CORTE_FINAL_EMAIL no .env com o e-mail de um usuário do Corte Final.')
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
  if (!user || user.status !== 'active') throw new ToolError(`Usuário ${email} não encontrado ou desativado.`)
  return user
}

const scope = (u: User) => (u.role === 'admin' ? {} : { ownerId: u.id })
async function project(u: User, id: string) {
  const p = await prisma.project.findFirst({ where: { id, ...scope(u) } })
  if (!p) throw new ToolError('Projeto não encontrado.')
  return p
}
const STATUS: Record<string, string> = {
  queued: 'na fila', analyzing: 'analisando a referência', scripting: 'escrevendo o roteiro', media: 'buscando mídia e gravando a voz',
  rendering: 'criando o vídeo', editing: 'pronto, em edição', in_approval: 'aguardando aprovação', approved: 'aprovado', failed: 'falhou',
}
const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5173'

export async function listProjects(u: User) {
  const rows = await prisma.project.findMany({ where: scope(u), orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, name: true, status: true, targetDurationS: true, createdAt: true } })
  return rows.map((p) => ({ ...p, status: STATUS[p.status] ?? p.status, link: `${WEB}/#/projeto/${p.id}` }))
}

export async function createVideo(u: User, a: { nome: string; prompt: string; duracao_minutos: number; link_referencia?: string; voz_desejada?: string; fonte?: string }) {
  const settings = Object.fromEntries((await prisma.setting.findMany()).map((s) => [s.key, s.value]))
  const maxS = Number(settings.max_duration_s ?? DEFAULT_SETTINGS.max_duration_s)
  const input = NewProjectInput.parse({
    name: a.nome, prompt: a.prompt, link: a.link_referencia, targetDurationS: Math.round(a.duracao_minutos * 60),
    fontFamily: a.fonte ?? 'Montserrat', highlightMode: 'palavra-chave', voiceBrief: a.voz_desejada,
  })
  if (input.targetDurationS > Math.min(maxS, MAX_DURATION_S)) throw new ToolError(`Duração máxima: ${Math.floor(Math.min(maxS, MAX_DURATION_S) / 60)} min.`)
  if (!DEFAULT_FONTS.includes(input.fontFamily as never) && !(await prisma.font.findFirst({ where: { family: input.fontFamily, enabled: true } }))) throw new ToolError('Fonte não liberada pelo admin.')
  const daily = Number(settings.daily_video_limit ?? 0)
  if (daily > 0 && await prisma.project.count({ where: { ownerId: u.id, createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } }) >= daily) {
    throw new ToolError(`Limite de ${daily} vídeos por dia atingido.`)
  }
  const p = await prisma.project.create({
    data: {
      ownerId: u.id, name: input.name, prompt: input.prompt, targetDurationS: input.targetDurationS,
      options: JSON.stringify({ fontFamily: input.fontFamily, highlightMode: input.highlightMode, voiceBrief: input.voiceBrief }),
      reference: input.link ? { create: { sourceType: 'link', url: input.link } } : undefined,
      jobs: { create: { type: 'ingest', stage: 'Na fila' } },
    },
  })
  return { id: p.id, status: 'na fila', link: `${WEB}/#/projeto/${p.id}`, aviso: 'Imagens próprias só pelo site (Novo vídeo).' }
}

export async function projectStatus(u: User, id: string) {
  const p = await project(u, id)
  const job = await prisma.job.findFirst({ where: { projectId: id, status: { in: ['queued', 'running', 'paused', 'failed'] } }, orderBy: { createdAt: 'desc' } })
  const video = await prisma.videoVersion.findFirst({ where: { projectId: id, isCurrent: true }, select: { version: true, durationS: true } })
  return {
    nome: p.name, status: STATUS[p.status] ?? p.status,
    etapa: job ? { tarefa: job.type, etapa: job.stage, progresso: job.progress, restante_s: job.etaS, situacao: job.status, erro: job.error } : null,
    video: video ? { versao: video.version, duracao_s: Math.round(video.durationS) } : null,
    link: `${WEB}/#/projeto/${id}`,
  }
}

export async function viewScript(u: User, id: string) {
  await project(u, id)
  const script = await prisma.script.findFirst({ where: { projectId: id }, orderBy: { version: 'desc' }, include: { scenes: { orderBy: { index: 'asc' } } } })
  const meta = await prisma.metadataField.findMany({ where: { projectId: id, isCurrent: true } })
  if (!script) return { aviso: 'O roteiro ainda não foi escrito.' }
  return {
    ...Object.fromEntries(meta.map((m) => [m.field === 'title' ? 'titulo' : m.field === 'description' ? 'descricao' : 'palavras_chave', m.value])),
    roteiro: script.body,
    cenas: script.scenes.map((s) => ({ indice: s.index, inicio_s: s.startS, fim_s: s.endS, narracao: s.narration, na_tela: s.onScreenText })),
  }
}

export async function requestChange(u: User, a: { id: string; parte: string; texto: string; tempo_segundos?: number }) {
  await project(u, a.id)
  const part = Part.parse(a.parte)
  const cr = await prisma.changeRequest.create({ data: { projectId: a.id, part, text: a.texto.slice(0, 1000), type: 'outro', frameTimeS: a.tempo_segundos ?? null, authorId: u.id } })
  return { id: cr.id, proximo_passo: `Chame regerar_parte com parte "${part}" para aplicar.` }
}

export async function regenerate(u: User, a: { id: string; parte: string }) {
  const p = await project(u, a.id)
  const part = Part.parse(a.parte)
  if (!['editing', 'in_approval', 'failed'].includes(p.status)) throw new ToolError('O vídeo ainda está sendo criado ou já foi aprovado.')
  if (await prisma.job.findFirst({ where: { projectId: p.id, status: { in: ['queued', 'running', 'paused'] } } })) throw new ToolError('Já existe uma tarefa em andamento neste projeto.')
  if (part === 'video' && !(await prisma.changeRequest.count({ where: { projectId: p.id, part, status: 'open' } }))) throw new ToolError('Marque um pedido de alteração no vídeo antes (pedir_alteracao).')
  await prisma.job.create({ data: { projectId: p.id, type: 'regen_part', stage: 'Na fila', payload: JSON.stringify({ part }) } })
  return { ok: true, acompanhe: `${WEB}/#/editar/${p.id}` }
}

export async function claudeUsage(u: User) {
  const s = await prisma.claudeStatus.findFirst({ orderBy: { checkedAt: 'desc' } })
  const base = { disponivel: s?.available ?? null, avisos: claudeWarnings(s, u.role === 'admin').map((w) => w.text) }
  if (u.role !== 'admin' || !s) return base
  return { ...base, plano: s.subscriptionType, sessao_restante_pct: s.sessionUsedPct == null ? null : 100 - s.sessionUsedPct, sessao_reinicia: s.sessionResetsAt, semana_restante_pct: s.weekUsedPct == null ? null : 100 - s.weekUsedPct, semana_reinicia: s.weekResetsAt }
}
