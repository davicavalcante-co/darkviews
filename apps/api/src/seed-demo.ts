import { hash } from '@node-rs/argon2'
import { prisma } from '@corte/db'
import { DEMO_USERS } from '@corte/shared/src/demo.js'

for (const u of DEMO_USERS) {
  const passwordHash = await hash(u.password)
  await prisma.user.upsert({
    where: { email: u.email },
    update: { passwordHash, role: u.role, status: 'active' },
    create: { email: u.email, name: u.name, role: u.role, passwordHash },
  })
  console.log(`${u.role.padEnd(5)}  ${u.email}`)
}
console.log('Contas de teste prontas (senhas em packages/shared/src/demo.ts).')
await prisma.$disconnect()
