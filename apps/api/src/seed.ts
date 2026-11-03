import { prisma } from '@corte/db'
import { newToken, sha256 } from './security.js'

const email = (process.env.ADMIN_EMAIL ?? 'admin@example.com').toLowerCase()
const existing = await prisma.user.findUnique({ where: { email } })

if (existing?.passwordHash) {
  console.log(`Admin ${email} já configurado. Nada a fazer.`)
} else {
  if (!existing) await prisma.user.create({ data: { email, name: 'Administrador', role: 'admin' } })
  const token = newToken()
  await prisma.setting.upsert({
    where: { key: 'setup_token_hash' },
    update: { value: sha256(token) },
    create: { key: 'setup_token_hash', value: sha256(token) },
  })
  console.log(`\nAdmin: ${email}\nToken de primeiro acesso (use na tela de login, aba "Primeiro acesso"):\n\n  ${token}\n`)
}
await prisma.$disconnect()
