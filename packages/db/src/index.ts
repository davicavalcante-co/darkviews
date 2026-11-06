import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()
export * from '@prisma/client'
export * from './files.js'
export * from './jobs.js'
export * from './crypto.js'
export * from './log.js'

// Fora da pasta pública: arquivos só saem por rotas autenticadas da API.
export const STORAGE_DIR = process.env.STORAGE_DIR ?? resolve(import.meta.dirname, '../../../storage')

// Tudo de um vídeo numa pasta só: storage/projetos/<nome-do-projeto>-<id curto>/<subpasta>.
// Subpastas: envios, referencia, midia, narracao, videos, quadros, cortes-dos-envios, cortes-verticais, miniaturas.
// A pasta é achada pelo id curto no fim do nome (renomear o projeto não muda a pasta); só é criada com o nome se não existir.
export const PROJECTS_DIR = join(STORAGE_DIR, 'projetos')
const known = new Map<string, string>()
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'video'
export async function projectDir(id: string, sub = '', name?: string) {
  let dir = known.get(id)
  if (!dir || !existsSync(dir)) {
    const tag = `-${id.slice(0, 8)}`
    const found = existsSync(PROJECTS_DIR) ? readdirSync(PROJECTS_DIR).find((d) => d.endsWith(tag)) : undefined
    if (found) dir = join(PROJECTS_DIR, found)
    else {
      const n = name ?? (await prisma.project.findUnique({ where: { id }, select: { name: true } }))?.name ?? 'video'
      dir = join(PROJECTS_DIR, slug(n) + tag)
    }
    known.set(id, dir)
  }
  const out = join(dir, sub)
  mkdirSync(out, { recursive: true })
  return out
}
