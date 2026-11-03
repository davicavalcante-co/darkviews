import { z } from 'zod'

export const CutPlatform = z.enum(['shorts', 'reels', 'tiktok', 'stories'])
export type CutPlatform = z.infer<typeof CutPlatform>
// Duração máxima de cada corte (s). Stories são divididos em partes de 15 s.
export const CUT_LIMITS: Record<CutPlatform, number> = { shorts: 60, reels: 90, tiktok: 180, stories: 15 }
export const CUT_LABELS: Record<CutPlatform, string> = { shorts: 'YouTube Shorts', reels: 'Instagram Reels', tiktok: 'TikTok', stories: 'Stories' }
const MAX_STORY_PARTS = 12

export const ApproveInput = z.object({
  platforms: z.array(CutPlatform).min(1).refine((a) => new Set(a).size === a.length, 'Plataforma repetida'),
  startS: z.number().min(0),
  endS: z.number().positive(),
  cropX: z.number().min(0).max(100),
}).refine((i) => i.endS - i.startS >= 3, 'O trecho precisa ter pelo menos 3 segundos')

export const RedoCutInput = z.object({ cropX: z.number().min(0).max(100) })

export function planCuts(input: { platforms: CutPlatform[]; startS: number; endS: number }, videoDurationS: number) {
  const end = Math.min(input.endS, videoDurationS)
  const cuts: { platform: CutPlatform; partIndex: number; startS: number; endS: number }[] = []
  for (const platform of input.platforms) {
    if (platform === 'stories') {
      for (let t = input.startS, i = 0; t < end - 1 && i < MAX_STORY_PARTS; t += CUT_LIMITS.stories, i++) {
        cuts.push({ platform, partIndex: i, startS: t, endS: Math.min(t + CUT_LIMITS.stories, end) })
      }
    } else {
      cuts.push({ platform, partIndex: 0, startS: input.startS, endS: Math.min(end, input.startS + CUT_LIMITS[platform]) })
    }
  }
  return cuts
}
