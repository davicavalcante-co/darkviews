import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()
export * from '@prisma/client'
export * from './files.js'
export * from './jobs.js'
export * from './crypto.js'
export * from './log.js'

// Fora da pasta pública: arquivos só saem por rotas autenticadas da API.
export const STORAGE_DIR = process.env.STORAGE_DIR ?? resolve(import.meta.dirname, '../../../storage')
