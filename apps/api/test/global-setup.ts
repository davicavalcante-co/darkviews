import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

// Banco de teste descartável: apaga e recria a cada execução.
export default function () {
  const dbDir = resolve(import.meta.dirname, '../../../packages/db')
  rmSync(resolve(dbDir, 'prisma/test.db'), { force: true })
  execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate'], {
    cwd: dbDir, stdio: 'ignore', env: { ...process.env, DATABASE_URL: 'file:./test.db' },
  })
}
