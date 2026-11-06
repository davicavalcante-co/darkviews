import { beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hash } from '@node-rs/argon2'
import { prisma, STORAGE_DIR } from '@corte/db'
import { buildApp } from '../src/app.js'

const ORIGIN = 'http://localhost:5173'
const PASS = 'senha-forte-123'
let app: Awaited<ReturnType<typeof buildApp>>
let dono: Record<string, string>, outro: Record<string, string>
let projectId = ''
const body = { platforms: ['shorts', 'stories'], startS: 5, endS: 40 }

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASS } })
  return { origin: ORIGIN, cookie: `sid=${res.cookies[0].value}`, 'x-csrf-token': res.json().csrfToken }
}

beforeAll(async () => {
  const passwordHash = await hash(PASS)
  const u = await prisma.user.create({ data: { email: 'dono@c.com', name: 'D', role: 'user', passwordHash } })
  await prisma.user.create({ data: { email: 'outro@c.com', name: 'O', role: 'user', passwordHash } })
  projectId = (await prisma.project.create({ data: { ownerId: u.id, name: 'C', prompt: 'x', targetDurationS: 60, status: 'editing' } })).id
  app = await buildApp()
  dono = await login('dono@c.com'); outro = await login('outro@c.com')
})

describe('aprovação', () => {
  it('sem a cópia sem legenda, pede para renderizar de novo', async () => {
    await prisma.videoVersion.create({ data: { projectId, version: 1, filePath: '/nao/existe.mp4', durationS: 60, renderSettings: '{}' } })
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/approve`, headers: dono, payload: body })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/Renderize/)
  })

  it('aprova, cria cortes pelo limite de cada plataforma e o job; outro usuário recebe 404', async () => {
    const dir = join(STORAGE_DIR, 'renders', projectId); mkdirSync(dir, { recursive: true })
    const clean = join(dir, 'v2-sem-legenda.mp4'); writeFileSync(clean, 'x')
    await prisma.videoVersion.updateMany({ where: { projectId }, data: { isCurrent: false } })
    await prisma.videoVersion.create({ data: { projectId, version: 2, filePath: clean, durationS: 60, renderSettings: JSON.stringify({ clean }) } })

    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/approve`, headers: outro, payload: body })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/approve`, headers: dono, payload: { ...body, endS: 6 } })).statusCode).toBe(400)
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/approve`, headers: dono, payload: body })
    expect(res.statusCode).toBe(202)
    const list = (await app.inject({ url: `/api/projects/${projectId}/cuts`, headers: dono })).json()
    expect(list.status).toBe('approved')
    expect(list.cuts.filter((c: { platform: string }) => c.platform === 'stories')).toHaveLength(3) // 5–20, 20–35, 35–40
    expect(list.cuts.find((c: { platform: string }) => c.platform === 'shorts')).toMatchObject({ startS: 5, endS: 40 })
    expect(JSON.stringify(list)).not.toMatch(/filePath|storage/)
    expect(await prisma.job.count({ where: { projectId, type: 'cuts' } })).toBe(1)
  })

  it('projeto aprovado não pode mais ser editado nem excluído pelo dono', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/render`, headers: dono })).statusCode).toBe(409)
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: dono })).statusCode).toBe(403)
  })
})
