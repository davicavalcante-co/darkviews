import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { logEvent, STORAGE_DIR } from '@corte/db'
import { run } from './ffmpeg.js'

const SOURCE = resolve(import.meta.dirname, '../native/subject-mask.swift')
const BIN = join(STORAGE_DIR, 'bin', 'subject-mask')

// Máscara do objeto principal da foto (Vision do macOS), para o efeito parallax. Compila a ferramenta na primeira vez.
// Sem objeto, fora do Mac ou com erro: devolve null e a cena usa Ken Burns.
export async function subjectMask(image: string): Promise<string | null> {
  const out = `${image}.mask.png`
  if (existsSync(out)) return out
  try {
    if (!existsSync(BIN)) {
      await mkdir(join(STORAGE_DIR, 'bin'), { recursive: true })
      await run('swiftc', ['-O', '-o', BIN, SOURCE], { timeout: 180_000 })
    }
    await run(BIN, [image, out], { timeout: 60_000 })
    return out
  } catch (e) {
    logEvent({ level: 'info', source: 'worker', kind: 'render', message: `parallax: sem recorte do objeto (${(e as Error).message.slice(0, 120)}); usando Ken Burns`, details: { image } })
    return null
  }
}
