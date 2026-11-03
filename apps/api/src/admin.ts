import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import { prisma, STORAGE_DIR } from '@corte/db'
import { FontInput, FontToggle, SettingsInput } from '@corte/shared'
import { requireAdmin, requireAuth } from './auth.js'
import { allFonts, enabledFonts, getSettings } from './settings.js'

const run = promisify(execFile)
const FONT_MAX = 10 * 1024 * 1024

// Tipo real da fonte pelos primeiros bytes: TrueType (00 01 00 00 ou "true") e OpenType ("OTTO"). WOFF não serve para a legenda.
async function fontExt(path: string) {
  const fh = await open(path, 'r')
  try {
    const b = Buffer.alloc(4); await fh.read(b, 0, 4, 0)
    const tag = b.toString('latin1')
    return b.equals(Buffer.from([0, 1, 0, 0])) || tag === 'true' ? 'ttf' : tag === 'OTTO' ? 'otf' : null
  } finally { await fh.close() }
}

// Nome da família gravado dentro do arquivo (é por ele que a legenda encontra a fonte).
async function fontFamilyOf(path: string) {
  try {
    const { stdout } = await run('fc-scan', ['--format', '%{family[0]}', path], { timeout: 10_000 })
    return stdout.trim() || null
  } catch { return null }
}

export async function adminRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: FONT_MAX + 1, files: 1, fields: 2 } })

  // Enviar uma fonte própria (qualquer usuário logado). Fica liberada para todos; o admin pode bloquear em Fontes.
  app.post('/api/fonts/upload', { preHandler: requireAuth }, async (req, reply) => {
    const part = await req.file()
    if (!part) return reply.code(400).send({ error: 'Escolha um arquivo de fonte (.ttf ou .otf)' })
    const dir = join(STORAGE_DIR, 'fonts')
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `envio-${randomUUID()}`)
    await pipeline(part.file, createWriteStream(tmp))
    const ext = await fontExt(tmp)
    if (part.file.truncated || (await stat(tmp)).size > FONT_MAX || !ext) {
      await rm(tmp, { force: true })
      return reply.code(400).send({ error: ext ? 'A fonte pode ter até 10 MB' : 'Use um arquivo de fonte .ttf ou .otf' })
    }
    const family = (await fontFamilyOf(tmp)) ?? part.filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
    if (!/^[\p{L}\p{N} .'&-]{2,60}$/u.test(family)) { await rm(tmp, { force: true }); return reply.code(400).send({ error: 'Não deu para ler o nome desta fonte' }) }
    const file = `${tmp}.${ext}`
    await rename(tmp, file)
    await prisma.font.upsert({ where: { family }, update: { enabled: true, cachedFilePath: file }, create: { family, weights: '[400]', enabled: true, cachedFilePath: file } })
    await audit(req.user!.id, 'font.upload', 'font', family, { family }, req.ip)
    return reply.code(201).send({ family })
  })

  const admin = { preHandler: requireAdmin }
  const audit = (actorId: string, action: string, targetType: string, targetId: string | null, details: object, ip: string) =>
    prisma.auditLog.create({ data: { actorId, action, targetType, targetId, details: JSON.stringify(details), ip } })

  // ---------- Plano e limites ----------
  app.get('/api/admin/settings', admin, async () => getSettings())

  app.put('/api/admin/settings', admin, async (req) => {
    const input = SettingsInput.parse(req.body)
    const before = await getSettings()
    for (const [key, value] of Object.entries(input)) {
      await prisma.setting.upsert({ where: { key }, update: { value: String(value) }, create: { key, value: String(value) } })
    }
    await audit(req.user!.id, 'settings.update', 'settings', null, { from: before, to: input }, req.ip)
    return input
  })

  // ---------- Fontes ----------
  app.get('/api/fonts', { preHandler: requireAuth }, async () => enabledFonts())

  app.get('/api/admin/fonts', admin, async () => allFonts())

  app.post('/api/admin/fonts', admin, async (req, reply) => {
    const { family } = FontInput.parse(req.body)
    // Confere no Google Fonts antes de liberar (chamada do servidor, nunca do navegador).
    const res = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null)
    if (!res?.ok) return reply.code(400).send({ error: `"${family}" não existe no Google Fonts` })
    await prisma.font.upsert({ where: { family }, update: { enabled: true }, create: { family, weights: '[400,700,900]', enabled: true } })
    await audit(req.user!.id, 'font.enable', 'font', family, { family }, req.ip)
    return reply.code(201).send({ family })
  })

  app.put<{ Params: { family: string } }>('/api/admin/fonts/:family', admin, async (req, reply) => {
    const { enabled } = FontToggle.parse(req.body)
    const family = req.params.family
    if (!(await allFonts()).some((f) => f.family === family)) return reply.code(404).send({ error: 'Fonte não encontrada' })
    if (!enabled && (await enabledFonts()).filter((f) => f !== family).length === 0) return reply.code(409).send({ error: 'Deixe pelo menos uma fonte liberada' })
    await prisma.font.upsert({ where: { family }, update: { enabled }, create: { family, weights: '[400,700,900]', enabled } })
    await audit(req.user!.id, enabled ? 'font.enable' : 'font.disable', 'font', family, { enabled }, req.ip)
    return { ok: true }
  })

  // ---------- Auditoria ----------
  app.get<{ Querystring: { limit?: string } }>('/api/admin/audit', admin, async (req) => {
    const rows = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' }, take: Math.min(Number(req.query.limit) || 100, 500),
      include: { actor: { select: { name: true, email: true } } },
    })
    return rows.map((r) => ({ id: r.id, createdAt: r.createdAt, actor: r.actor?.name ?? 'sistema', action: r.action, targetType: r.targetType, targetId: r.targetId, details: JSON.parse(r.details), ip: r.ip }))
  })
}
