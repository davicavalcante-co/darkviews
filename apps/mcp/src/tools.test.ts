import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@corte/db'
import { actingUser, claudeUsage, createVideo, listProjects, projectStatus, regenerate, ToolError } from './tools'

let ana: Awaited<ReturnType<typeof actingUser>>, beto: typeof ana, adm: typeof ana

beforeAll(async () => {
  await prisma.user.createMany({ data: [
    { email: 'ana@m.com', name: 'Ana', role: 'user' }, { email: 'beto@m.com', name: 'Beto', role: 'user' },
    { email: 'adm@m.com', name: 'Adm', role: 'admin' }, { email: 'off@m.com', name: 'Off', role: 'user', status: 'disabled' },
  ] })
  ;[ana, beto, adm] = await Promise.all(['ana@m.com', 'beto@m.com', 'adm@m.com'].map((e) => actingUser(e)))
})

describe('MCP do Corte Final', () => {
  it('exige usuário configurado e ativo', async () => {
    await expect(actingUser('')).rejects.toBeInstanceOf(ToolError)
    await expect(actingUser('off@m.com')).rejects.toThrow(/desativado/)
  })

  it('cria vídeo com a voz desejada e enfileira; outro usuário não enxerga', async () => {
    const r = await createVideo(ana, { nome: 'Café', prompt: 'Vídeo sobre café', duracao_minutos: 1, voz_desejada: 'mulher jovem, animada' })
    const p = await prisma.project.findUniqueOrThrow({ where: { id: r.id }, include: { jobs: true } })
    expect(JSON.parse(p.options).voiceBrief).toBe('mulher jovem, animada')
    expect(p.jobs[0].type).toBe('ingest')
    expect((await listProjects(beto)).length).toBe(0)
    await expect(projectStatus(beto, r.id)).rejects.toThrow('Projeto não encontrado.')
    expect((await projectStatus(adm, r.id)).nome).toBe('Café')
  })

  it('respeita 18 minutos, o limite diário e o link permitido', async () => {
    await expect(createVideo(ana, { nome: 'x', prompt: 'x', duracao_minutos: 19 })).rejects.toThrow()
    await expect(createVideo(ana, { nome: 'x', prompt: 'x', duracao_minutos: 1, link_referencia: 'https://evil.test/v' })).rejects.toThrow()
    await prisma.setting.create({ data: { key: 'daily_video_limit', value: '1' } })
    await expect(createVideo(ana, { nome: 'x', prompt: 'x', duracao_minutos: 1 })).rejects.toThrow(/Limite de 1/)
    await prisma.setting.deleteMany({ where: { key: 'daily_video_limit' } })
  })

  it('não regera vídeo sem pedido marcado nem durante outra tarefa', async () => {
    const p = await prisma.project.create({ data: { ownerId: ana.id, name: 'E', prompt: 'p', targetDurationS: 60, status: 'editing' } })
    await expect(regenerate(ana, { id: p.id, parte: 'video' })).rejects.toThrow(/pedido de alteração/)
    expect(await regenerate(ana, { id: p.id, parte: 'title' })).toMatchObject({ ok: true })
    await expect(regenerate(ana, { id: p.id, parte: 'title' })).rejects.toThrow(/em andamento/)
  })

  it('limites do plano só para admin', async () => {
    await prisma.claudeStatus.create({ data: { available: true, sessionUsedPct: 40, subscriptionType: 'pro' } })
    expect(await claudeUsage(ana)).not.toHaveProperty('plano')
    expect(await claudeUsage(adm)).toMatchObject({ plano: 'pro', sessao_restante_pct: 60 })
  })
})
