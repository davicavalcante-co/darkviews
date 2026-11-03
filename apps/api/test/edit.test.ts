import { beforeAll, describe, expect, it } from 'vitest'
import { hash } from '@node-rs/argon2'
import { prisma } from '@corte/db'
import { buildApp } from '../src/app.js'

const ORIGIN = 'http://localhost:5173'
const PASS = 'senha-forte-123'
let app: Awaited<ReturnType<typeof buildApp>>
let dono: Record<string, string>, outro: Record<string, string>
let projectId = ''

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASS } })
  return { origin: ORIGIN, cookie: `sid=${res.cookies[0].value}`, 'x-csrf-token': res.json().csrfToken }
}
const caption = (text: string) => ({
  fontFamily: 'Inter', fontWeight: 700, size: 64, color: '#FFFFFF', highlightColor: '#FFD43B', highlightMode: 'manual', position: 'bottom',
  segments: [{ startS: 0, endS: 2, text, highlights: [0] }],
})

beforeAll(async () => {
  const passwordHash = await hash(PASS)
  const u = await prisma.user.create({ data: { email: 'dono@e.com', name: 'Dono', role: 'user', passwordHash } })
  await prisma.user.create({ data: { email: 'outro@e.com', name: 'Outro', role: 'user', passwordHash } })
  projectId = (await prisma.project.create({ data: { ownerId: u.id, name: 'Ed', prompt: 'x', targetDurationS: 60, status: 'editing' } })).id
  await prisma.metadataField.create({ data: { projectId, field: 'title', version: 1, value: 'Título 1', createdBy: 'claude' } })
  app = await buildApp()
  dono = await login('dono@e.com'); outro = await login('outro@e.com')
})

describe('versões', () => {
  it('editar título cria versão nova e desmarca a anterior; voltar atrás vira outra versão', async () => {
    const put = await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/metadata/title`, headers: dono, payload: { value: 'Título 2' } })
    expect(put.json().version).toBe(2)
    const back = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/metadata/title/restore`, headers: dono, payload: { version: 1 } })
    expect(back.json().version).toBe(3)
    const rows = await prisma.metadataField.findMany({ where: { projectId, field: 'title' }, orderBy: { version: 'asc' } })
    expect(rows.map((r) => [r.value, r.isCurrent])).toEqual([['Título 1', false], ['Título 2', false], ['Título 1', true]])
  })

  it('legenda: salva versão, valida tempo e restaura', async () => {
    expect((await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/captions`, headers: dono, payload: caption('Olá mundo') })).json().version).toBe(1)
    expect((await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/captions`, headers: dono, payload: caption('Tchau') })).json().version).toBe(2)
    const bad = caption('x'); bad.segments[0].endS = 0
    expect((await app.inject({ method: 'PUT', url: `/api/projects/${projectId}/captions`, headers: dono, payload: bad })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/captions/restore`, headers: dono, payload: { version: 1 } })).json().version).toBe(3)
    const edit = (await app.inject({ url: `/api/projects/${projectId}/edit`, headers: dono })).json()
    expect(edit.caption.segments[0]).toMatchObject({ text: 'Olá mundo', highlights: [0] })
    expect(JSON.stringify(edit)).not.toMatch(/filePath|storage/)
  })
})

describe('acesso e fila', () => {
  it('outro usuário recebe 404 em todas as rotas de edição', async () => {
    const reqs = [
      { method: 'GET' as const, url: `/api/projects/${projectId}/edit` },
      { method: 'PUT' as const, url: `/api/projects/${projectId}/metadata/title`, payload: { value: 'hack' } },
      { method: 'PUT' as const, url: `/api/projects/${projectId}/captions`, payload: caption('hack') },
      { method: 'POST' as const, url: `/api/projects/${projectId}/change-requests`, payload: { part: 'title', text: 'hack' } },
      { method: 'POST' as const, url: `/api/projects/${projectId}/regen`, payload: { part: 'title' } },
      { method: 'POST' as const, url: `/api/projects/${projectId}/render` },
    ]
    for (const r of reqs) expect((await app.inject({ ...r, headers: outro })).statusCode, r.url).toBe(404)
  })

  it('regerar vídeo exige pedido marcado; um job por vez', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/regen`, headers: dono, payload: { part: 'video' } })).statusCode).toBe(400)
    await app.inject({ method: 'POST', url: `/api/projects/${projectId}/change-requests`, headers: dono, payload: { part: 'video', frameTimeS: 3.5, text: 'troque a foto' } })
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/regen`, headers: dono, payload: { part: 'video' } })).statusCode).toBe(202)
    const job = await prisma.job.findFirst({ where: { projectId, type: 'regen_part' } })
    expect(JSON.parse(job!.payload!)).toEqual({ part: 'video' })
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/regen`, headers: dono, payload: { part: 'title' } })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/render`, headers: dono })).statusCode).toBe(409)
  })
})
