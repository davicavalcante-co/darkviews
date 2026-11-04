import { beforeAll, expect, it } from 'vitest'
import { hash } from '@node-rs/argon2'
import { prisma } from '@corte/db'
import { buildApp } from '../src/app.js'

const ORIGIN = 'http://localhost:5173'
let app: Awaited<ReturnType<typeof buildApp>>
let cris: Record<string, string>, davi: Record<string, string>, voiceId: string

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { email, password: 'senha-forte-123' } })
  return { origin: ORIGIN, cookie: `sid=${res.cookies[0].value}`, 'x-csrf-token': res.json().csrfToken }
}

beforeAll(async () => {
  const passwordHash = await hash('senha-forte-123')
  const [c] = await Promise.all(['cris@v.com', 'davi@v.com'].map((email) => prisma.user.create({ data: { email, name: email, passwordHash } })))
  voiceId = (await prisma.studioVoice.create({ data: { ownerId: c.id, name: 'Minha narração', kind: 'clone', samplePath: '/nao/existe.wav', profileId: 'abc123' } })).id
  app = await buildApp()
  cris = await login('cris@v.com'); davi = await login('davi@v.com')
})

const voiceIds = async (headers: Record<string, string>) => (await app.inject({ url: '/api/voices', headers })).json().voices.map((v: { id: string }) => v.id)

it('rascunho não aparece no Novo vídeo; publicada aparece só para a dona', async () => {
  expect(await voiceIds(cris)).not.toContain(`studio:${voiceId}`)
  const r = await app.inject({ method: 'PATCH', url: `/api/studio/voices/${voiceId}`, headers: cris, payload: { published: true } })
  expect(r.json().status).toBe('published')
  expect(await voiceIds(cris)).toContain(`studio:${voiceId}`)
  expect(await voiceIds(davi)).not.toContain(`studio:${voiceId}`)
})

it('outra pessoa não vê, edita nem apaga a voz', async () => {
  expect((await app.inject({ url: '/api/studio/voices', headers: davi })).json()).toEqual([])
  expect((await app.inject({ method: 'PATCH', url: `/api/studio/voices/${voiceId}`, headers: davi, payload: { name: 'x' } })).statusCode).toBe(404)
  expect((await app.inject({ method: 'DELETE', url: `/api/studio/voices/${voiceId}`, headers: davi })).statusCode).toBe(404)
})
