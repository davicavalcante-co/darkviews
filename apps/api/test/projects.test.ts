import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { hash } from '@node-rs/argon2'
import { claimNextJob, prisma } from '@corte/db'
import { buildApp } from '../src/app.js'

const ORIGIN = 'http://localhost:5173'
const PASS = 'senha-forte-123'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(32)])
let app: Awaited<ReturnType<typeof buildApp>>
type Auth = { headers: Record<string, string> }
let ana: Auth, beto: Auth, admin: Auth

async function login(email: string): Promise<Auth> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASS } })
  return { headers: { origin: ORIGIN, cookie: `sid=${res.cookies[0].value}`, 'x-csrf-token': res.json().csrfToken } }
}

const base = { name: 'Café', prompt: 'Vídeo sobre café', targetDurationS: '120', fontFamily: 'Inter', highlightMode: 'karaokê' }

async function create(auth: Auth, fields: Record<string, string> = {}, files: [string, Buffer, string][] = []) {
  const form = new FormData()
  for (const [k, v] of Object.entries({ ...base, ...fields })) form.append(k, v)
  for (const [field, buf, name] of files) form.append(field, new Blob([new Uint8Array(buf)]), name)
  const req = new Request('http://x', { method: 'POST', body: form })
  return app.inject({
    method: 'POST', url: '/api/projects',
    headers: { ...auth.headers, 'content-type': req.headers.get('content-type')! },
    payload: Buffer.from(await req.arrayBuffer()),
  })
}

beforeAll(async () => {
  const passwordHash = await hash(PASS)
  await prisma.user.createMany({ data: [
    { email: 'ana@p.com', name: 'Ana', role: 'user', passwordHash },
    { email: 'beto@p.com', name: 'Beto', role: 'user', passwordHash },
    { email: 'adm@p.com', name: 'Adm', role: 'admin', passwordHash },
  ] })
  app = await buildApp()
  ;[ana, beto, admin] = [await login('ana@p.com'), await login('beto@p.com'), await login('adm@p.com')]
})

describe('novo vídeo', () => {
  it('cria projeto com imagens e link, e enfileira o job de ingestão', async () => {
    const res = await create(ana, { link: 'https://youtu.be/abc', captions: '["fachada"]' }, [['images', PNG, 'foto.png']])
    expect(res.statusCode).toBe(201)
    const p = await prisma.project.findUnique({ where: { id: res.json().id }, include: { reference: true, assets: true, jobs: true } })
    expect(p!.reference!.platform).toBe('youtube')
    expect(p!.assets[0].userCaption).toBe('fachada')
    expect(p!.assets[0].filePath).not.toContain('foto') // nome trocado por UUID
    expect(p!.jobs.map((j) => j.type)).toEqual(['ingest'])
  })

  it('recusa duração acima de 18 minutos', async () => {
    expect((await create(ana, { targetDurationS: '1081' })).statusCode).toBe(400)
  })

  it('recusa link fora da lista de plataformas', async () => {
    expect((await create(ana, { link: 'https://evil.test/v' })).statusCode).toBe(400)
  })

  it('confere o tipo real: texto renomeado para .png é recusado e apagado', async () => {
    const before = await prisma.asset.count()
    const res = await create(ana, {}, [['images', Buffer.from('não sou imagem, só texto qualquer'), 'falsa.png']])
    expect(res.statusCode).toBe(415)
    expect(await prisma.asset.count()).toBe(before)
  })

  it('vídeo no campo de imagens é recusado; vídeo de referência é aceito', async () => {
    expect((await create(ana, {}, [['images', MP4, 'a.png']])).statusCode).toBe(415)
    expect((await create(ana, {}, [['video', MP4, 'ref.mp4']])).statusCode).toBe(201)
  })

  it('link e vídeo juntos é recusado', async () => {
    expect((await create(ana, { link: 'https://youtu.be/abc' }, [['video', MP4, 'ref.mp4']])).statusCode).toBe(400)
  })
})

describe('acesso a projetos', () => {
  it('outro usuário recebe 404; admin vê', async () => {
    const id = (await create(ana)).json().id
    expect((await app.inject({ url: `/api/projects/${id}`, headers: beto.headers })).statusCode).toBe(404)
    expect((await app.inject({ url: `/api/projects/${id}/events`, headers: beto.headers })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${id}`, headers: beto.headers })).statusCode).toBe(404)
    expect((await app.inject({ url: `/api/projects/${id}`, headers: admin.headers })).statusCode).toBe(200)
    const list = (await app.inject({ url: '/api/projects', headers: beto.headers })).json()
    expect(list.find((p: { id: string }) => p.id === id)).toBeUndefined()
    const mine = (await app.inject({ url: '/api/projects', headers: ana.headers })).json().find((p: { id: string }) => p.id === id)
    expect(mine).toMatchObject({ video: null, images: 0, job: { status: 'queued' } })
    expect(JSON.stringify(mine)).not.toMatch(/filePath|storage/)
  })

  it('a resposta nunca traz caminho de arquivo', async () => {
    const id = (await create(ana, {}, [['images', PNG, 'x.png'], ['video', MP4, 'r.mp4']])).json().id
    const body = (await app.inject({ url: `/api/projects/${id}`, headers: ana.headers })).body
    expect(body).not.toMatch(/filePath|storage|uploads/)
  })

  it('dono exclui antes da aprovação (e os arquivos somem); depois de aprovado, não', async () => {
    const id = (await create(ana, {}, [['images', PNG, 'x.png']])).json().id
    const file = (await prisma.asset.findFirst({ where: { projectId: id } }))!.filePath
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${id}`, headers: ana.headers })).statusCode).toBe(200)
    expect(existsSync(file)).toBe(false)
    const id2 = (await create(ana)).json().id
    await prisma.project.update({ where: { id: id2 }, data: { status: 'approved' } })
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${id2}`, headers: ana.headers })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${id2}`, headers: admin.headers })).statusCode).toBe(200)
  })
})

describe('fila de jobs', () => {
  it('dois workers disputando: cada job vai para um só', async () => {
    await prisma.job.updateMany({ where: { status: 'queued' }, data: { status: 'done' } })
    const id = (await create(ana)).json().id
    const [a, b] = await Promise.all([claimNextJob('w1', ['ingest']), claimNextJob('w2', ['ingest'])])
    const winners = [a, b].filter(Boolean)
    expect(winners).toHaveLength(1)
    expect(winners[0]!.projectId).toBe(id)
  })
})

describe('tentar de novo', () => {
  it('repete só a etapa que falhou, volta o status e não duplica', async () => {
    const id = (await create(ana)).json().id
    await prisma.job.updateMany({ where: { projectId: id }, data: { status: 'done' } })
    await prisma.job.create({ data: { projectId: id, type: 'render', status: 'failed', error: 'fonte', payload: null } })
    await prisma.project.update({ where: { id }, data: { status: 'failed' } })
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/retry`, headers: beto.headers })).statusCode).toBe(404)
    const r = await app.inject({ method: 'POST', url: `/api/projects/${id}/retry`, headers: ana.headers })
    expect(r.json()).toEqual({ retried: 'render' })
    expect((await prisma.project.findUniqueOrThrow({ where: { id } })).status).toBe('rendering')
    expect(await prisma.job.count({ where: { projectId: id, type: 'render', status: 'queued' } })).toBe(1)
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/retry`, headers: ana.headers })).statusCode).toBe(409)
  })
})

describe('enviar fonte', () => {
  const send = async (buf: Buffer, name: string) => {
    const form = new FormData(); form.append('font', new Blob([new Uint8Array(buf)]), name)
    const req = new Request('http://x', { method: 'POST', body: form })
    return app.inject({ method: 'POST', url: '/api/fonts/upload', headers: { ...ana.headers, 'content-type': req.headers.get('content-type')! }, payload: Buffer.from(await req.arrayBuffer()) })
  }
  it('aceita TTF de verdade, lê o nome de dentro e libera para todos', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const sys = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial Unicode.ttf'].find((f) => existsSync(f))
    if (!sys) return // sem fonte de sistema para testar nesta máquina
    const r = await send(readFileSync(sys), 'minha-fonte.ttf')
    expect(r.statusCode).toBe(201)
    expect(r.json().family).toMatch(/Arial/)
    expect((await app.inject({ url: '/api/fonts', headers: beto.headers })).json()).toContain(r.json().family)
  })
  it('recusa arquivo que não é fonte, mesmo com extensão .ttf', async () => {
    expect((await send(Buffer.from('isto não é uma fonte'), 'falsa.ttf')).statusCode).toBe(400)
  })
})
