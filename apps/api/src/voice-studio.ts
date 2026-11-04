import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import multipart from '@fastify/multipart'
import { z } from 'zod'
import { prisma, STORAGE_DIR } from '@corte/db'
import {
  STUDIO_ATTRS, STUDIO_SAMPLE_TEXT, StudioError, studioCreateProfile, studioDeleteProfile, studioGenerate, studioInstruct, studioStatus, toStudioWav,
} from '@corte/providers'
import { requireAuth } from './auth.js'

const PROJECT_DIR = join(import.meta.dirname, '../../..')
const VOICES_DIR = join(STORAGE_DIR, 'voices')
const Fields = z.object({
  name: z.string().trim().min(1, 'Dê um nome para a voz').max(60),
  kind: z.enum(['design', 'clone']),
  transcript: z.string().trim().max(1000).default(''),
  gender: z.string().optional(), age: z.string().optional(), pitch: z.string().optional(), style: z.string().optional(), accent: z.string().optional(),
})
const Patch = z.object({ name: z.string().trim().min(1).max(60).optional(), speed: z.number().min(0.7).max(1.3).optional(), published: z.boolean().optional() })

const pub = (v: { id: string; name: string; kind: string; status: string; attrs: string; speed: number; updatedAt: Date }) =>
  ({ id: v.id, name: v.name, kind: v.kind, status: v.status, attrs: JSON.parse(v.attrs), speed: v.speed, updatedAt: v.updatedAt })

// Lê o formulário (campos + áudio opcional) e monta a amostra que define a voz: gerada pelos atributos ou a gravação da pessoa.
async function buildSample(req: FastifyRequest) {
  const fields: Record<string, string> = {}
  let upload: string | null = null
  try {
    for await (const part of req.parts()) {
      if (part.type === 'field') fields[part.fieldname] = String(part.value)
      else if (part.fieldname === 'audio' && !upload) { upload = join(tmpdir(), `voz-${randomUUID()}`); await pipeline(part.file, createWriteStream(upload)) }
      else part.file.resume()
    }
    const f = Fields.parse(fields)
    await mkdir(VOICES_DIR, { recursive: true })
    const sample = join(VOICES_DIR, `${randomUUID()}.wav`)
    const attrs = f.kind === 'design' ? { gender: f.gender, age: f.age, pitch: f.pitch, style: f.style, accent: f.accent } : {}
    if (f.kind === 'clone') {
      if (!upload) throw Object.assign(new Error('Grave ou envie um áudio com a voz (de 5 a 30 segundos)'), { statusCode: 400 })
      await toStudioWav(upload, sample)
    } else {
      const instruct = studioInstruct(attrs)
      if (!instruct) throw Object.assign(new Error('Escolha ao menos uma característica da voz'), { statusCode: 400 })
      const tmp = sample + '.raw'
      await writeFile(tmp, await studioGenerate({ text: STUDIO_SAMPLE_TEXT, instruct }))
      await toStudioWav(tmp, sample).finally(() => rm(tmp, { force: true }))
    }
    // Na clonagem sem transcrição o VoiceStudio transcreve sozinho; na criada, o texto é o que foi falado.
    return { ...f, attrs, sample, refText: f.kind === 'design' ? STUDIO_SAMPLE_TEXT : f.transcript }
  } finally {
    if (upload) await rm(upload, { force: true })
  }
}

export async function voiceStudioRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 10 } })
  // Erro do VoiceStudio (desligado, licença) vira mensagem clara para o cliente.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof StudioError) return reply.code(503).send({ error: err.message })
    throw err
  })
  const mine = (req: FastifyRequest, id: string) => prisma.studioVoice.findFirst({ where: { id, ownerId: req.user!.id } })

  app.get('/api/studio/status', { preHandler: requireAuth }, async () => ({ ...(await studioStatus()), attrs: STUDIO_ATTRS, sampleText: STUDIO_SAMPLE_TEXT }))

  // Botão "Ligar VoiceStudio": usa o mesmo script de partida que a narração já usa.
  app.post('/api/studio/start', { preHandler: requireAuth }, async (_req, reply) => {
    if ((await studioStatus()).online) return { online: true }
    const home = process.env.OMNIVOICE_HOME ?? join(homedir(), 'OmniVoice-Studio')
    await promisify(execFile)(join(PROJECT_DIR, '.claude/skills/omnivoice/scripts/start-backend.sh'), [], { env: { ...process.env, OMNIVOICE_HOME: home }, timeout: 180_000 }).catch(() => {})
    const { online } = await studioStatus()
    return online ? { online } : reply.code(503).send({ error: 'Não consegui ligar o VoiceStudio. Confira se ele está instalado nesta máquina.' })
  })

  app.get('/api/studio/voices', { preHandler: requireAuth }, async (req) =>
    (await prisma.studioVoice.findMany({ where: { ownerId: req.user!.id }, orderBy: { createdAt: 'desc' } })).map(pub))

  app.post('/api/studio/voices', { preHandler: requireAuth }, async (req, reply) => {
    const s = await buildSample(req)
    try {
      const profileId = await studioCreateProfile(s.name, s.sample, s.refText)
      const v = await prisma.studioVoice.create({ data: { ownerId: req.user!.id, name: s.name, kind: s.kind, attrs: JSON.stringify(s.attrs), samplePath: s.sample, profileId } })
      return reply.code(201).send(pub(v))
    } catch (e) { await rm(s.sample, { force: true }); throw e }
  })

  // Refazer a voz (novos atributos ou nova gravação). Continua no mesmo status; a voz antiga é apagada no VoiceStudio.
  app.put<{ Params: { id: string } }>('/api/studio/voices/:id', { preHandler: requireAuth }, async (req, reply) => {
    const old = await mine(req, req.params.id)
    if (!old) return reply.code(404).send({ error: 'Voz não encontrada' })
    const s = await buildSample(req)
    let profileId: string
    try { profileId = await studioCreateProfile(s.name, s.sample, s.refText) } catch (e) { await rm(s.sample, { force: true }); throw e }
    const v = await prisma.studioVoice.update({ where: { id: old.id }, data: { name: s.name, kind: s.kind, attrs: JSON.stringify(s.attrs), samplePath: s.sample, profileId } })
    await rm(old.samplePath, { force: true })
    if (old.profileId) await studioDeleteProfile(old.profileId)
    return pub(v)
  })

  app.patch<{ Params: { id: string } }>('/api/studio/voices/:id', { preHandler: requireAuth }, async (req, reply) => {
    const v = await mine(req, req.params.id)
    if (!v) return reply.code(404).send({ error: 'Voz não encontrada' })
    const { published, ...rest } = Patch.parse(req.body)
    return pub(await prisma.studioVoice.update({ where: { id: v.id }, data: { ...rest, ...(published !== undefined && { status: published ? 'published' : 'draft' }) } }))
  })

  // Ouvir a voz falando um texto qualquer (até 300 caracteres).
  app.post<{ Params: { id: string } }>('/api/studio/voices/:id/preview', { preHandler: requireAuth }, async (req, reply) => {
    const v = await mine(req, req.params.id)
    if (!v?.profileId) return reply.code(404).send({ error: 'Voz não encontrada' })
    const { text } = z.object({ text: z.string().trim().min(1).max(300) }).parse(req.body)
    reply.header('content-type', 'audio/wav')
    return reply.send(await studioGenerate({ text, profileId: v.profileId, speed: v.speed }))
  })

  app.get<{ Params: { id: string } }>('/api/studio/voices/:id/sample', { preHandler: requireAuth }, async (req, reply) => {
    const v = await mine(req, req.params.id)
    if (!v) return reply.code(404).send({ error: 'Voz não encontrada' })
    reply.header('content-type', 'audio/wav')
    return reply.send(createReadStream(v.samplePath))
  })

  app.delete<{ Params: { id: string } }>('/api/studio/voices/:id', { preHandler: requireAuth }, async (req, reply) => {
    const v = await mine(req, req.params.id)
    if (!v) return reply.code(404).send({ error: 'Voz não encontrada' })
    await prisma.studioVoice.delete({ where: { id: v.id } })
    await rm(v.samplePath, { force: true })
    if (v.profileId) await studioDeleteProfile(v.profileId)
    return { ok: true }
  })
}
