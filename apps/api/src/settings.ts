import { prisma } from '@corte/db'
import { DEFAULT_FONTS, DEFAULT_SETTINGS, type Settings } from '@corte/shared'

export async function getSettings(): Promise<Settings> {
  const rows = await prisma.setting.findMany({ where: { key: { in: Object.keys(DEFAULT_SETTINGS) } } })
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const r of rows) s[r.key] = typeof DEFAULT_SETTINGS[r.key as keyof Settings] === 'number' ? Number(r.value) : r.value
  return s as Settings
}

// Todas as fontes conhecidas: as de fábrica (liberadas até o admin bloquear) mais as que o admin adicionou.
export async function allFonts() {
  const rows = await prisma.font.findMany({ select: { family: true, enabled: true } })
  const list = [...DEFAULT_FONTS.map((family) => ({ family, enabled: rows.find((r) => r.family === family)?.enabled ?? true })),
    ...rows.filter((r) => !DEFAULT_FONTS.includes(r.family as never))]
  return list.sort((a, b) => a.family.localeCompare(b.family))
}

export async function enabledFonts() {
  return (await allFonts()).filter((f) => f.enabled).map((f) => f.family)
}
