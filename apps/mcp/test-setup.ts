import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

// Banco de teste próprio (não divide com os testes da API, que podem rodar ao mesmo tempo).
export default function () {
  const dbDir = resolve(import.meta.dirname, '../../packages/db')
  rmSync(resolve(dbDir, 'prisma/test-mcp.db'), { force: true })
  execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate'], { cwd: dbDir, stdio: 'ignore', env: { ...process.env, DATABASE_URL: 'file:./test-mcp.db' } })
}
