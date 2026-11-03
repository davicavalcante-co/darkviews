import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { logEvent, prisma, STORAGE_DIR } from '@corte/db'

export const FONTS_DIR = join(STORAGE_DIR, 'fonts')

async function googleTtf(family: string, weight?: number) {
  const q = weight ? `${encodeURIComponent(family)}:wght@${weight}` : encodeURIComponent(family)
  const res = await fetch(`https://fonts.googleapis.com/css2?family=${q}`, { signal: AbortSignal.timeout(20_000) })
  return res.ok ? (await res.text()).match(/url\((https:[^)]+\.ttf)\)/)?.[1] ?? null : null
}

// Garante o arquivo da fonte em storage/fonts: primeiro a enviada pelo admin, depois o Google Fonts.
// Nunca derruba o vídeo: se não achar, avisa nos logs e a legenda sai com a fonte padrão do sistema.
export async function ensureFont(family: string, weight: number): Promise<string | null> {
  const row = await prisma.font.findUnique({ where: { family } })
  if (row?.cachedFilePath && existsSync(row.cachedFilePath)) return row.cachedFilePath
  const file = join(FONTS_DIR, `${family.replace(/\s+/g, '')}-${weight}.ttf`)
  if (existsSync(file)) return file
  try {
    await mkdir(FONTS_DIR, { recursive: true })
    // Nem toda fonte tem todos os pesos (Bebas Neue só tem o normal): tenta o peso pedido e, se não houver, o padrão.
    const url = (await googleTtf(family, weight)) ?? (await googleTtf(family))
    if (!url) throw new Error('não encontrada no Google Fonts')
    await writeFile(file, Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer()))
    await prisma.font.upsert({
      where: { family },
      update: { cachedFilePath: file }, // não mexe em enabled: bloquear é decisão do admin
      create: { family, weights: JSON.stringify([weight]), enabled: true, cachedFilePath: file },
    })
    return file
  } catch (e) {
    logEvent({ level: 'warn', source: 'worker', kind: 'integration', message: `fonte "${family}": ${(e as Error).message}; usando a fonte padrão`, details: { family, weight } })
    return null
  }
}
