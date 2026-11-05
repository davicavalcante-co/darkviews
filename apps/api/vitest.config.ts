import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    env: { NODE_ENV: 'test', DATABASE_URL: 'file:./test.db', WEB_ORIGIN: 'http://localhost:5173', STORAGE_DIR: join(tmpdir(), 'darkviews-test-storage'), MASTER_KEY: 'ab'.repeat(32), CLAUDE_CONFIG_DIR: join(tmpdir(), 'darkviews-test-claude') },
    fileParallelism: false, // os arquivos de teste dividem o mesmo banco
    globalSetup: './test/global-setup.ts',
  },
})
