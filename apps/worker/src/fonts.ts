import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { prisma, STORAGE_DIR } from '@corte/db'

export const FONTS_DIR = join(STORAGE_DIR, 'fonts')

// Baixa o TTF do Google Fonts uma vez e guarda em storage/fonts (tabela `fonts` registra o cache).
export async function ensureFont(family: string, weight: number) {
  const file = join(FONTS_DIR, `${family.replace(/\s+/g, '')}-${weight}.ttf`)
  if (existsSync(file)) return file
  await mkdir(FONTS_DIR, { recursive: true })
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`, { signal: AbortSignal.timeout(20_000) })).text()
  const url = css.match(/url\((https:[^)]+\.ttf)\)/)?.[1]
  if (!url) throw new Error(`Fonte "${family}" não encontrada no Google Fonts`)
  await writeFile(file, Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer()))
  await prisma.font.upsert({
    where: { family },
    update: { cachedFilePath: file }, // não mexe em enabled: bloquear é decisão do admin
    create: { family, weights: JSON.stringify([weight]), enabled: true, cachedFilePath: file },
  })
  return file
}
