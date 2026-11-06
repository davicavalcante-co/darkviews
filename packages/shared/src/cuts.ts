import { z } from 'zod'

export const CutPlatform = z.enum(['shorts', 'reels', 'tiktok', 'stories'])
export type CutPlatform = z.infer<typeof CutPlatform>
// Duração máxima de cada corte (s). Stories são divididos em partes de 15 s.
export const CUT_LIMITS: Record<CutPlatform, number> = { shorts: 60, reels: 90, tiktok: 180, stories: 15 }
export const CUT_LABELS: Record<CutPlatform, string> = { shorts: 'YouTube Shorts', reels: 'Instagram Reels', tiktok: 'TikTok', stories: 'Stories' }
const MAX_PARTS = 40 // por plataforma (18 min em cortes de 30 s)

export const CutBackground = z.enum(['blur', 'color']) // vídeo embaçado atrás ou a cor de fundo do vídeo
export const ApproveInput = z.object({
  platforms: z.array(CutPlatform).min(1).refine((a) => new Set(a).size === a.length, 'Plataforma repetida'),
  startS: z.number().min(0),
  endS: z.number().positive(),
  partS: z.number().min(3).optional(), // duração de cada corte; sem ela, o limite de cada plataforma
  background: CutBackground.default('blur'),
}).refine((i) => i.endS - i.startS >= 3, 'O trecho precisa ter pelo menos 3 segundos')

export const RedoCutInput = z.object({ background: CutBackground })

// Divide o trecho em cortes seguidos (0–1 min, 1–2 min...), sem repetir segundos. Sobra menor que 3 s entra no corte anterior.
export function planCuts(input: { platforms: CutPlatform[]; startS: number; endS: number; partS?: number }, videoDurationS: number) {
  const end = Math.min(input.endS, videoDurationS)
  const cuts: { platform: CutPlatform; partIndex: number; startS: number; endS: number }[] = []
  for (const platform of input.platforms) {
    const size = Math.min(platform === 'stories' ? CUT_LIMITS.stories : input.partS ?? CUT_LIMITS[platform], CUT_LIMITS[platform])
    for (let t = input.startS, i = 0; end - t >= 3 && i < MAX_PARTS; t += size, i++) {
      const stop = end - (t + size) < 3 && end - t <= CUT_LIMITS[platform] ? end : Math.min(t + size, end)
      cuts.push({ platform, partIndex: i, startS: t, endS: stop })
      if (stop === end) break
    }
  }
  return cuts
}
