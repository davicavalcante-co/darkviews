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

async function create(auth: Auth, fields: Record<string, string> = {}, files: [string, Buffer, string][] = [], url = '/api/projects') {
  const form = new FormData()
  for (const [k, v] of Object.entries({ ...base, ...fields })) form.append(k, v)
  for (const [field, buf, name] of files) form.append(field, new Blob([new Uint8Array(buf)]), name)
  const req = new Request('http://x', { method: 'POST', body: form })
  return app.inject({
    method: 'POST', url,
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
    expect(p!.assets[0].filePath).toMatch(/projetos\/cafe-[0-9a-f]{8}\/envios\/foto-[0-9a-f]{8}\.png$/) // pasta do projeto; nome original trocado
    expect(p!.jobs.map((j) => j.type)).toEqual(['ingest'])
  })

  it('aceita até 60 minutos e recusa acima', async () => {
    expect((await create(ana, { targetDurationS: '3601' })).statusCode).toBe(400)
  })

  it('só vídeos com vídeos enviados: corta, aprova, apaga os reprovados e repõe ou repete', async () => {
    expect((await create(ana, {}, [['footage', MP4, 'longo.mp4']])).statusCode).toBe(400) // vídeo para cortar só em "Só vídeos"
    const res = await create(ana, { mediaMode: 'videos' }, [['footage', MP4, 'longo.mp4'], ['footage', MP4, 'outro.mp4']])
    expect(res.statusCode).toBe(201)
    const id = res.json().id
    const p = await prisma.project.findUnique({ where: { id }, include: { assets: true, jobs: true } })
    expect(p!.assets.filter((a) => a.kind === 'user_video')).toHaveLength(2)
    expect(JSON.parse(p!.options)).toMatchObject({ method: 'cortes', mediaMode: 'videos' })
    expect(p!.jobs.map((j) => j.type)).toEqual(['script'])

    // Simula o worker: 3 cortes esperando aprovação
    const cuts = await Promise.all([0, 1, 2].map((i) => prisma.asset.create({ data: { projectId: id, kind: 'footage_cut', filePath: `/tmp/nao-existe-${i}.mp4`, mime: 'video/mp4', durationS: 4, sourceId: JSON.stringify({ path: 'x', startS: i * 10, lenS: 4 }) } })))
    await prisma.project.update({ where: { id }, data: { status: 'cut_review' } })
    expect((await app.inject({ url: `/api/projects/${id}/cut-review`, headers: ana.headers })).json().pending).toHaveLength(3)
    expect((await app.inject({ url: `/api/projects/${id}/cut-review`, headers: beto.headers })).statusCode).toBe(404)
    const r = await app.inject({ method: 'POST', url: `/api/projects/${id}/cut-review`, headers: ana.headers, payload: { rejected: [cuts[0].id], refill: 'new' } })
    expect(r.json()).toMatchObject({ removed: 1, next: 'novos_cortes' })
    const after = await prisma.project.findUnique({ where: { id }, include: { assets: true, jobs: { orderBy: { createdAt: 'desc' }, take: 1 } } })
    expect(after!.assets.some((a) => a.id === cuts[0].id)).toBe(false) // reprovado apagado
    expect(after!.assets.filter((a) => a.kind === 'footage_clip')).toHaveLength(2)
    expect(JSON.parse(after!.jobs[0].payload!)).toEqual({ count: 1 })
    expect(JSON.parse(after!.options).cutRanges).toHaveLength(1) // o trecho reprovado não é cortado de novo
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/cut-review`, headers: ana.headers, payload: {} })).statusCode).toBe(409)
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

describe('tokens por vídeo', () => {
  it('soma os tokens do projeto e estima pela média dos prontos', async () => {
    const id = (await create(ana)).json().id
    await prisma.project.update({ where: { id }, data: { status: 'editing', targetDurationS: 60 } })
    const job = await prisma.job.findFirstOrThrow({ where: { projectId: id } })
    await prisma.claudeUsageEvent.create({ data: { jobId: job.id, model: 'm', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 400, cacheWriteTokens: 100 } })
    const row = (await app.inject({ url: '/api/projects', headers: ana.headers })).json().find((r: { id: string }) => r.id === id)
    expect(row.tokens).toBe(2000)
    const est = (await app.inject({ url: '/api/projects/estimate?seconds=120', headers: ana.headers })).json()
    expect(est.basedOn).toBeGreaterThan(0)
    expect(est.tokens).toBeGreaterThan(0)
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

describe('aprovação das imagens', () => {
  async function setup() {
    const id = (await create(ana)).json().id
    await prisma.job.updateMany({ where: { projectId: id }, data: { status: 'done' } })
    const script = await prisma.script.create({ data: { projectId: id, version: 1, body: 'b', scenePlan: '[]', createdBy: 'claude' } })
    const mk = (i: number, sid: string) => prisma.asset.create({ data: { projectId: id, kind: 'stock_image', filePath: '/tmp/x.jpg', mime: 'image/jpeg', sourceProvider: 'pixabay', sourceId: sid } })
    const [a0, a1] = [await mk(0, 'p0'), await mk(1, 'p1')]
    const q = JSON.stringify({ type: 'stock', kind: 'image', queries: ['coffee'], orientation: 'landscape' })
    await prisma.scene.createMany({ data: [
      { scriptId: script.id, index: 0, startS: 0, endS: 3, narration: 'cena 0', assetId: a0.id, searchQuery: q },
      { scriptId: script.id, index: 1, startS: 3, endS: 6, narration: 'cena 1', assetId: a1.id, searchQuery: q },
    ] })
    await prisma.project.update({ where: { id }, data: { status: 'image_review' } })
    return id
  }

  it('lista as imagens para aprovar sem expor caminho; outro usuário recebe 404', async () => {
    const id = await setup()
    const r = (await app.inject({ url: `/api/projects/${id}/review`, headers: ana.headers })).json()
    expect(r.scenes.map((s: { index: number; bank: string }) => [s.index, s.bank])).toEqual([[0, 'Pixabay'], [1, 'Pixabay']])
    expect(JSON.stringify(r)).not.toMatch(/filePath|\/tmp/)
    expect((await app.inject({ url: `/api/projects/${id}/review`, headers: beto.headers })).statusCode).toBe(404)
  })

  it('aprovar tudo segue para a narração', async () => {
    const id = await setup()
    const r = await app.inject({ method: 'POST', url: `/api/projects/${id}/review`, headers: ana.headers, payload: { rejected: [] } })
    expect(r.json()).toMatchObject({ next: 'narracao' })
    expect(await prisma.job.count({ where: { projectId: id, type: 'voice', status: 'queued' } })).toBe(1)
  })

  it('recusar uma cena busca outra só para ela e lembra a recusada', async () => {
    const id = await setup()
    const r = await app.inject({ method: 'POST', url: `/api/projects/${id}/review`, headers: ana.headers, payload: { rejected: [1] } })
    expect(r.json()).toMatchObject({ next: 'nova_busca', replaced: 1 })
    const scenes = await prisma.scene.findMany({ where: { script: { projectId: id } }, orderBy: { index: 'asc' } })
    expect(scenes[0].assetId).not.toBeNull() // aprovada fica
    expect(scenes[1].assetId).toBeNull()
    expect(JSON.parse(scenes[1].searchQuery!).rejected).toEqual(['pixabay:p1'])
    expect(await prisma.job.count({ where: { projectId: id, type: 'media', status: 'queued' } })).toBe(1)
    expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/review`, headers: ana.headers, payload: { rejected: [] } })).statusCode).toBe(409)
  })
})

describe('nova versão', () => {
  it('mantém, remove e acrescenta imagens na ordem pedida e volta para o roteiro', async () => {
    const id = (await create(ana, {}, [['images', PNG, 'a.png'], ['images', PNG, 'b.png']])).json().id
    await prisma.job.updateMany({ where: { projectId: id }, data: { status: 'done' } })
    const [a] = await prisma.asset.findMany({ where: { projectId: id, kind: 'user_image' }, orderBy: { sortOrder: 'asc' } })
    const order = JSON.stringify([{ new: true, caption: 'nova' }, { id: a.id, caption: 'mantida' }])
    const res = await create(ana, { name: 'V2', order, bgColor: '#FF0000', useStock: '0' }, [['images', PNG, 'c.png']], `/api/projects/${id}/regenerate`)
    expect(res.statusCode).toBe(202)
    const imgs = await prisma.asset.findMany({ where: { projectId: id, kind: 'user_image' }, orderBy: { sortOrder: 'asc' } })
    expect(imgs.map((i) => i.userCaption)).toEqual(['nova', 'mantida'])
    const p = await prisma.project.findUniqueOrThrow({ where: { id } })
    expect(p.name).toBe('V2'); expect(p.status).toBe('scripting')
    expect(JSON.parse(p.options)).toMatchObject({ bgColor: '#FF0000', useStock: false })
    // Só a voz muda: não refaz roteiro nem imagens, só narra e monta.
    await prisma.job.updateMany({ where: { projectId: id }, data: { status: 'done' } })
    const keep = JSON.stringify((await prisma.asset.findMany({ where: { projectId: id, kind: 'user_image' }, orderBy: { sortOrder: 'asc' } })).map((x) => ({ id: x.id, caption: x.userCaption ?? '' })))
    const voiceOnly = await create(ana, { name: 'V2', order: keep, bgColor: '#FF0000', useStock: '0', voiceTone: 'animada' }, [], `/api/projects/${id}/regenerate`)
    expect(voiceOnly.json().redo).toBe('voice')
    await prisma.job.updateMany({ where: { projectId: id }, data: { status: 'done' } })
    const renderOnly = await create(ana, { name: 'V2', order: keep, bgColor: '#00FF00', useStock: '0', voiceTone: 'animada' }, [], `/api/projects/${id}/regenerate`)
    expect(renderOnly.json().redo).toBe('render')
    // Enquanto cria, não aceita outra versão.
    expect((await create(ana, { order: '[]' }, [], `/api/projects/${id}/regenerate`)).statusCode).toBe(409)
  })
})

describe('pessoa falando na referência', () => {
  it('só aceita a escolha quando o vídeo está esperando, e segue para o roteiro', async () => {
    const id = (await create(ana)).json().id
    const post = () => app.inject({ method: 'POST', url: `/api/projects/${id}/talking-head`, headers: ana.headers, payload: { choice: 'stock' } })
    expect((await post()).statusCode).toBe(409)
    await prisma.project.update({ where: { id }, data: { status: 'talking_head' } })
    expect((await post()).statusCode).toBe(202)
    const p = await prisma.project.findUniqueOrThrow({ where: { id }, include: { jobs: { where: { type: 'script' } } } })
    expect(p.status).toBe('scripting')
    expect(JSON.parse(p.options).talkingHead).toBe('stock')
    expect(p.jobs).toHaveLength(1)
  })
})

describe('voz e thumbnail', () => {
  it('lista todas as vozes prontas com a origem, e a principal vem marcada', async () => {
    const v = (await app.inject({ url: '/api/voices', headers: ana.headers })).json()
    expect(v.current).toBe('kokoro:pf_dora')
    expect(v.voices).toContainEqual(expect.objectContaining({ id: 'kokoro:pf_dora', label: 'Dora - Mulher (Kokoro)' }))
    expect(v.voices.some((x: { provider: string }) => x.provider === 'piper')).toBe(true)
    expect(v.tones.map((t: { id: string }) => t.id)).toEqual(['calma', 'natural', 'animada'])
  })
  it('salva e lista thumbnails do projeto', async () => {
    const id = (await create(ana)).json().id
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)])
    const form = new FormData(); form.append('images', new Blob([new Uint8Array(jpg)]), 'thumbnail.jpg')
    const req = new Request('http://x', { method: 'POST', body: form })
    const r = await app.inject({ method: 'POST', url: `/api/projects/${id}/thumbnails`, headers: { ...ana.headers, 'content-type': req.headers.get('content-type')! }, payload: Buffer.from(await req.arrayBuffer()) })
    expect(r.statusCode).toBe(201)
    expect((await app.inject({ url: `/api/projects/${id}/thumbnails`, headers: ana.headers })).json()).toHaveLength(1)
    expect((await app.inject({ url: `/api/projects/${id}/thumbnails`, headers: beto.headers })).statusCode).toBe(404)
  })
})
