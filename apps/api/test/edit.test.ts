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

describe('aba Legendas', () => {
  it('aplicar liga a legenda e pede só a troca da legenda; tirar desliga', async () => {
    await prisma.job.updateMany({ where: { projectId }, data: { status: 'done' } })
    await prisma.project.update({ where: { id: projectId }, data: { status: 'editing' } })
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/captions/apply`, headers: dono, payload: { on: true } })).statusCode).toBe(202)
    const job = await prisma.job.findFirstOrThrow({ where: { projectId, status: 'queued' } })
    expect([job.type, JSON.parse(job.payload!)]).toEqual(['render', { captionsOnly: true }])
    expect(JSON.parse((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).options).captionsOn).toBe(true)
    // Com a tarefa na fila, não aceita outra.
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/captions/apply`, headers: dono, payload: { on: false } })).statusCode).toBe(409)
  })
})

describe('editor em camadas', () => {
  it('muda enunciado e motion da cena, e o estilo dos enunciados vale para o projeto', async () => {
    const script = await prisma.script.create({ data: { projectId, version: 9, body: '{}', scenePlan: '[]', createdBy: 'claude', scenes: { create: [{ index: 0, startS: 0, endS: 3, narration: 'Oi', onScreenText: 'Capítulo 1' }] } } })
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}/scenes/0`, headers: dono, payload: { onScreenText: 'Novo título', motion: 'parallax' } })).statusCode).toBe(200)
    expect(await prisma.scene.findFirst({ where: { scriptId: script.id }, select: { onScreenText: true, motion: true } })).toEqual({ onScreenText: 'Novo título', motion: 'parallax' })
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}/scenes/0`, headers: dono, payload: { motion: 'voar' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}/scenes/0`, headers: outro, payload: { onScreenText: 'x' } })).statusCode).toBe(404)
    const titleStyle = { fontFamily: 'Inter', size: 150, color: '#FFFFFF', bandColor: '#FF0000' }
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}/options`, headers: dono, payload: { titleStyle, sfxVolume: 0 } })).statusCode).toBe(200)
    const edit = (await app.inject({ url: `/api/projects/${projectId}/edit`, headers: dono })).json()
    expect(edit.options).toMatchObject({ titleStyle, sfxVolume: 0 })
    expect(edit.scenes[0]).toMatchObject({ onScreenText: 'Novo título', kind: 'card' })
  })
})

describe('aba Versões: o que mudou fica anotado', () => {
  it('cena, opções e legenda anotam antes → depois', async () => {
    await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}/scenes/0`, headers: dono, payload: { motion: 'snap_zoom' } })
    await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}/options`, headers: dono, payload: { musicVolume: 20 } })
    const notes = JSON.parse((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).options).pendingChanges as string[]
    expect(notes).toContain('Cena 1 · motion: Parallax 2.5D → Zoom rápido')
    expect(notes.some((n) => n.startsWith('Volume da trilha:') && n.endsWith('→ 20%'))).toBe(true)
  })
})

describe('criação: tempo, parar e descartar', () => {
  it('estima cada etapa, para a criação e descarta a tentativa que falhou', async () => {
    const t = (await app.inject({ url: `/api/projects/${projectId}/timing`, headers: dono })).json()
    expect(t.estimateS).toBeGreaterThan(0)
    expect(t.stages.map((s: { type: string }) => s.type)).toContain('render')
    await prisma.job.create({ data: { projectId, type: 'render', status: 'queued', stage: 'Na fila' } })
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/cancel`, headers: dono })).statusCode).toBe(200)
    expect((await prisma.job.findFirstOrThrow({ where: { projectId, type: 'render' }, orderBy: { createdAt: 'desc' } })).status).toBe('failed')
    // Sem versão pronta não dá para descartar; com versão, volta para a edição.
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/discard`, headers: dono })).statusCode).toBe(409)
    await prisma.videoVersion.create({ data: { projectId, version: 1, filePath: '/x.mp4', durationS: 10, renderSettings: '{}' } })
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/discard`, headers: dono })).statusCode).toBe(200)
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('editing')
  })
})

describe('cartela: duração por bloco', () => {
  it('muda a duração e empurra as cenas seguintes; cena com fala não muda', async () => {
    const sc = await prisma.script.create({ data: { projectId, version: 20, body: '{}', scenePlan: '[]', createdBy: 'claude', scenes: { create: [
      { index: 0, startS: 0, endS: 2, narration: null, onScreenText: 'Capítulo' },
      { index: 1, startS: 2, endS: 5, narration: 'fala' },
    ] } } })
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}/scenes/0`, headers: dono, payload: { durationS: 3.5 } })).statusCode).toBe(200)
    const rows = await prisma.scene.findMany({ where: { scriptId: sc.id }, orderBy: { index: 'asc' }, select: { startS: true, endS: true } })
    expect(rows).toEqual([{ startS: 0, endS: 3.5 }, { startS: 3.5, endS: 6.5 }])
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}/scenes/1`, headers: dono, payload: { durationS: 1 } })).statusCode).toBe(400)
  })
})

describe('versões: favoritar e excluir sem apagar o projeto', () => {
  it('favorita, exclui uma versão (a anterior vira atual) e não deixa excluir a última', async () => {
    await prisma.job.updateMany({ where: { projectId }, data: { status: 'done' } })
    await prisma.videoVersion.deleteMany({ where: { projectId } })
    await prisma.videoVersion.createMany({ data: [
      { projectId, version: 1, filePath: '/nao/existe-1.mp4', durationS: 10, renderSettings: '{}', isCurrent: false },
      { projectId, version: 2, filePath: '/nao/existe-2.mp4', durationS: 10, renderSettings: '{}', isCurrent: true },
    ] })
    expect((await app.inject({ method: 'PATCH', url: `/api/projects/${projectId}/versions/1`, headers: dono, payload: { favorite: true } })).json().favorite).toBe(true)
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/versions/2`, headers: outro })).statusCode).toBe(404)
    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/versions/2`, headers: dono })
    expect(del.json()).toMatchObject({ ok: true, current: 1 })
    expect((await prisma.videoVersion.findFirstOrThrow({ where: { projectId } })).isCurrent).toBe(true)
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/versions/1`, headers: dono })).statusCode).toBe(409)
    expect(await prisma.project.count({ where: { id: projectId } })).toBe(1)
  })
})

describe('aprovação das imagens em rodadas', () => {
  it('as aprovadas não voltam; a próxima rodada mostra só as que foram recusadas', async () => {
    await prisma.job.updateMany({ where: { projectId }, data: { status: 'done' } })
    await prisma.project.update({ where: { id: projectId }, data: { status: 'image_review' } })
    const img = (n: number) => prisma.asset.create({ data: { projectId, kind: 'stock_image', filePath: `/nao/${n}.jpg`, mime: 'image/jpeg', sourceProvider: 'web', sourceId: String(n), license: 'Direitos autorais do dono (não verificado)' } })
    const [a, b, c] = await Promise.all([img(1), img(2), img(3)])
    const q = JSON.stringify({ type: 'stock', kind: 'image', orientation: 'landscape', queries: ['x'] })
    await prisma.script.create({ data: { projectId, version: 30, body: '{}', scenePlan: '[]', createdBy: 'claude', scenes: { create: [
      { index: 0, startS: 0, endS: 2, narration: 'a', assetId: a.id, searchQuery: q },
      { index: 1, startS: 2, endS: 4, narration: 'b', assetId: b.id, searchQuery: q },
      { index: 2, startS: 4, endS: 6, narration: 'c', assetId: c.id, searchQuery: q },
    ] } } })
    const first = (await app.inject({ url: `/api/projects/${projectId}/review`, headers: dono })).json()
    expect(first.scenes.map((s: { index: number }) => s.index)).toEqual([0, 1, 2])
    expect(first.scenes[0].copyright).toBe(true)
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/review`, headers: dono, payload: { rejected: [1] } })).json().replaced).toBe(1)
    // Nova imagem para a cena recusada (o worker faria isso) e volta para a aprovação.
    const d = await img(4)
    const s1 = await prisma.scene.findFirstOrThrow({ where: { script: { projectId, version: 30 }, index: 1 } })
    await prisma.scene.update({ where: { id: s1.id }, data: { assetId: d.id } })
    await prisma.job.updateMany({ where: { projectId }, data: { status: 'done' } })
    await prisma.project.update({ where: { id: projectId }, data: { status: 'image_review' } })
    const second = (await app.inject({ url: `/api/projects/${projectId}/review`, headers: dono })).json()
    expect(second.scenes.map((s: { index: number }) => s.index)).toEqual([1])
    expect(second.round).toBe(2)
    // 2ª rodada: envia a própria foto para a cena; ela sai da lista já aprovada.
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
    const form = new FormData(); form.append('images', new Blob([new Uint8Array(PNG)]), 'minha.png')
    const req = new Request('http://x', { method: 'POST', body: form })
    const up = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/review/1/upload`, headers: { ...dono, 'content-type': req.headers.get('content-type')! }, payload: Buffer.from(await req.arrayBuffer()) })
    expect(up.statusCode).toBe(201)
    expect((await app.inject({ url: `/api/projects/${projectId}/review`, headers: dono })).json().scenes).toEqual([])
  })
})

describe('aprovação do roteiro', () => {
  it('edita falas, refaz com dicas e aprova para seguir às imagens', async () => {
    await prisma.job.updateMany({ where: { projectId }, data: { status: 'done' } })
    await prisma.project.update({ where: { id: projectId }, data: { status: 'script_review' } })
    const sc = await prisma.script.create({ data: { projectId, version: 40, body: '{}', scenePlan: '[]', createdBy: 'claude', scenes: { create: [{ index: 0, startS: 0, endS: 3, narration: 'Fala antiga' }] } } })
    const send = (body: object) => app.inject({ method: 'POST', url: `/api/projects/${projectId}/script-review`, headers: dono, payload: body })
    expect((await send({ action: 'redo' })).statusCode).toBe(400) // refazer pede a dica
    expect((await send({ action: 'save', scenes: [{ index: 0, narration: 'Fala nova', onScreenText: 'Título' }] })).statusCode).toBe(200)
    expect(await prisma.scene.findFirst({ where: { scriptId: sc.id }, select: { narration: true, onScreenText: true } })).toEqual({ narration: 'Fala nova', onScreenText: 'Título' })
    expect((await send({ action: 'redo', hint: 'mais curto' })).statusCode).toBe(202)
    const redo = await prisma.job.findFirstOrThrow({ where: { projectId, status: 'queued' } })
    expect([redo.type, JSON.parse(redo.payload!).hint]).toEqual(['script', 'mais curto'])
    expect((await send({ action: 'approve' })).statusCode).toBe(409) // já não está esperando aprovação
    await prisma.job.updateMany({ where: { projectId }, data: { status: 'done' } })
    await prisma.project.update({ where: { id: projectId }, data: { status: 'script_review' } })
    expect((await send({ action: 'approve' })).statusCode).toBe(202)
    expect((await prisma.job.findFirstOrThrow({ where: { projectId, status: 'queued' } })).type).toBe('media')
  })
})

describe('aba Análise', () => {
  it('cria a análise pelo link, abre os detalhes e usa o estilo num vídeo novo (direto para o roteiro)', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/analyses', headers: dono, payload: { url: 'https://exemplo.com/x' } })).statusCode).toBe(400)
    const a = (await app.inject({ method: 'POST', url: '/api/analyses', headers: dono, payload: { url: 'https://www.youtube.com/watch?v=abc123' } })).json()
    expect(a).toMatchObject({ status: 'queued', platform: 'youtube' })
    expect((await app.inject({ url: `/api/analyses/${a.id}`, headers: outro })).statusCode).toBe(404)
    await prisma.videoAnalysis.update({ where: { id: a.id }, data: { status: 'done', title: 'Vídeo X', profile: JSON.stringify({ pacing: 'rápido' }), details: JSON.stringify({ summary: 'ok' }) } })
    expect((await app.inject({ url: `/api/analyses/${a.id}`, headers: dono })).json().details.summary).toBe('ok')
    const form = new FormData()
    for (const [k, v] of Object.entries({ name: 'Do estilo', prompt: 'Vídeo novo', targetDurationS: '60', analysisId: a.id })) form.append(k, v)
    const req = new Request('http://x', { method: 'POST', body: form })
    const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { ...dono, 'content-type': req.headers.get('content-type')! }, payload: Buffer.from(await req.arrayBuffer()) })
    expect(res.statusCode).toBe(201)
    const p = await prisma.project.findUniqueOrThrow({ where: { id: res.json().id }, include: { reference: true, jobs: true } })
    expect([p.status, p.jobs.map((j) => j.type), p.reference?.sourceType, p.reference?.styleProfile]).toEqual(['scripting', ['script'], 'analysis', JSON.stringify({ pacing: 'rápido' })])
  })
})

describe('identidade e brainstorm', () => {
  it('identidade começa no padrão do sistema, salva a da pessoa e vira o padrão do editor', async () => {
    const first = (await app.inject({ url: '/api/me/identity', headers: dono })).json()
    expect(first.identity).toEqual(first.system)
    const mine = { ...first.system, bgColor: '#15273D', title: { ...first.system.title, color: '#FFD43B', cardAlign: 'bottom-left' } }
    expect((await app.inject({ method: 'PUT', url: '/api/me/identity', headers: dono, payload: { ...mine, caption: { ...mine.caption, fontFamily: 'Fonte Que Não Existe' } } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'PUT', url: '/api/me/identity', headers: dono, payload: mine })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/me/identity', headers: outro })).json().identity.bgColor).toBe(first.system.bgColor) // cada um com a sua
    const p = await prisma.project.create({ data: { ownerId: (await prisma.user.findFirstOrThrow({ where: { email: 'dono@e.com' } })).id, name: 'Id', prompt: 'x', targetDurationS: 60, status: 'editing' } })
    const opts = (await app.inject({ url: `/api/projects/${p.id}/edit`, headers: dono })).json().options
    expect(opts).toMatchObject({ bgColor: '#15273D', titleStyle: { color: '#FFD43B', cardAlign: 'bottom-left' } })
  })

  it('brainstorm entra na fila e só a dona vê', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/brainstorms', headers: dono, payload: { niche: 'x' } })).statusCode).toBe(400)
    const b = (await app.inject({ method: 'POST', url: '/api/brainstorms', headers: dono, payload: { niche: 'história do futebol' } })).json()
    expect(b).toMatchObject({ status: 'queued', niche: 'história do futebol' })
    expect((await app.inject({ url: '/api/brainstorms', headers: outro })).json()).toEqual([])
    expect((await app.inject({ method: 'DELETE', url: `/api/brainstorms/${b.id}`, headers: outro })).statusCode).toBe(404)
  })
})
