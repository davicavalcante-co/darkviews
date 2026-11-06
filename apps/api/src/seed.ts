import { prisma } from '@corte/db'
import { newToken, sha256 } from './security.js'

// Instalação nova: cria a conta admin sem senha e um token de primeiro acesso.
// Na tela de login (aba "Primeiro acesso") a pessoa cola o token; dentro do sistema define e-mail e senha.
if (await prisma.user.findFirst({ where: { passwordHash: { not: null } } })) {
  console.log('Conta já configurada. Nada a fazer.')
} else {
  if (!(await prisma.user.findFirst({ where: { role: 'admin', passwordHash: null } }))) {
    await prisma.user.create({ data: { email: 'admin@darkviews.local', name: 'Administrador', role: 'admin' } })
  }
  const token = newToken()
  await prisma.setting.upsert({ where: { key: 'setup_token_hash' }, update: { value: sha256(token) }, create: { key: 'setup_token_hash', value: sha256(token) } })
  console.log(`\nToken de primeiro acesso (use na tela de login, aba "Primeiro acesso"):\n\n  ${token}\n`)
}
await prisma.$disconnect()
