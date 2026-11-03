// Teste manual: narra duas frases pelo Claude Code + skill omnivoice + MCP, sem criar projeto.
// Uso: pnpm --filter @corte/worker exec tsx --env-file=../../.env scripts/omnivoice-teste.ts
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { STORAGE_DIR } from '@corte/db'
import { ensureOmniVoice, narrateWithClaude } from '../src/omnivoice.js'

const dir = join(STORAGE_DIR, 'amostras', 'omnivoice')
await mkdir(dir, { recursive: true })
console.log('OmniVoice ligado?', await ensureOmniVoice())
const t = Date.now()
const files = await narrateWithClaude({
  jobId: '', projectId: 'teste-omnivoice', dir, brief: 'mulher jovem, animada, tom de conversa', steps: '16', speed: '1.05',
  scenes: [
    { index: 0, text: 'Eu passei muito tempo esperando o dia certo pra começar.' },
    { index: 1, text: 'Mas sabe o que eu descobri? Ele nunca chega sozinho.' },
  ],
})
console.log(`pronto em ${((Date.now() - t) / 1000).toFixed(0)} s:`, Object.fromEntries(files))
setTimeout(() => process.exit(0), 500) // deixa os logs terminarem de gravar
