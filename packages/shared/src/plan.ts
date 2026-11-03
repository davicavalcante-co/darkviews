import { z } from 'zod'
import { MAX_DURATION_S } from './index'

// Perfil de estilo que o Claude extrai da referência.
export const StyleProfile = z.object({
  pacing: z.string().describe('Ritmo geral: lento, médio, acelerado, e por quê'),
  cutsPerMinute: z.number().describe('Cortes por minuto estimados'),
  shotTypes: z.array(z.string()).describe('Enquadramentos mais usados'),
  captionStyle: z.string().describe('Como são as legendas: posição, tamanho, destaques'),
  palette: z.array(z.string()).describe('Cores dominantes em hex'),
  structure: z.array(z.string()).describe('Partes do roteiro na ordem: gancho, problema, ...'),
  tone: z.string().describe('Tom da narração'),
  notes: z.string().describe('Outras observações úteis para recriar o estilo'),
  transitions: z.array(z.string()).describe('Transições usadas (corte seco, fade, zoom, slide, whip...), quando e com que frequência'),
  composition: z.string().describe('Composição dos quadros: regra dos terços, centralização, espaço para texto, profundidade, ângulo da câmera'),
  setting: z.string().describe('Cenários e ambientes que aparecem (estúdio, rua, natureza, tela de computador...)'),
  imagery: z.string().describe('Tipo de imagem: fotos ou vídeos, de banco ou próprias, ilustração, gráficos, B-roll; como se movem'),
  textOnScreen: z.string().describe('Textos na tela além da legenda: títulos, números, setas, destaques; fonte, cor e posição'),
  audio: z.string().describe('Música, efeitos sonoros e pausas da narração'),
  recommendations: z.array(z.string()).describe('Recomendações práticas e específicas para o novo vídeo imitar este estilo'),
  talkingHead: z.object({
    present: z.boolean().describe('Há trechos com uma pessoa falando para a câmera (o mesmo enquadramento de rosto se repetindo)?'),
    segments: z.array(z.object({ startS: z.number(), endS: z.number(), description: z.string() })).describe('Trechos aproximados com a pessoa falando'),
  }),
})
export type StyleProfile = z.infer<typeof StyleProfile>

const Media = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_image'), imageIndex: z.number().int().min(0).describe('Índice da imagem enviada pelo usuário') }),
  z.object({
    type: z.literal('stock'),
    kind: z.enum(['image', 'video']),
    queries: z.array(z.string()).min(1).max(3).describe('2 a 3 termos de busca em inglês'),
    orientation: z.enum(['landscape', 'portrait', 'square']),
  }),
  z.object({ type: z.literal('user_video'), note: z.string().describe('O que o vídeo do cliente mostra neste trecho') }),
  z.object({ type: z.literal('text_card'), text: z.string().describe('Quadro de texto 2D quando nenhuma imagem serve') }),
])

export const Scene = z.object({
  startS: z.number().min(0),
  endS: z.number().positive(),
  narration: z.string(),
  onScreenText: z.string().describe('Texto curto na tela, ou vazio'),
  media: Media,
  transition: z.enum(['cut', 'fade', 'slide', 'zoom']),
})

export const ScriptOutput = z.object({
  title: z.string().max(100),
  description: z.string().max(5000),
  keywords: z.array(z.string()).min(3).max(30),
  body: z.string().describe('Roteiro completo, em texto corrido'),
  scenes: z.array(Scene).min(1),
})
export type ScriptOutput = z.infer<typeof ScriptOutput>

// Regras que o JSON Schema não expressa. Devolve a lista de problemas (vazia = ok).
export function checkPlan(plan: ScriptOutput, targetDurationS: number, imageCount: number): string[] {
  const errors: string[] = []
  const end = plan.scenes.at(-1)!.endS
  if (end > MAX_DURATION_S) errors.push(`O vídeo passa de 18 minutos (${end}s)`)
  if (Math.abs(end - targetDurationS) > Math.max(5, targetDurationS * 0.1)) {
    errors.push(`Duração total ${end}s longe da duração pedida (${targetDurationS}s)`)
  }
  plan.scenes.forEach((s, i) => {
    const prevEnd = i === 0 ? 0 : plan.scenes[i - 1].endS
    if (Math.abs(s.startS - prevEnd) > 0.05) errors.push(`Cena ${i + 1} não começa onde a anterior termina`)
    if (s.endS <= s.startS) errors.push(`Cena ${i + 1} tem duração zero ou negativa`)
    if (s.media.type === 'user_image' && s.media.imageIndex >= imageCount) errors.push(`Cena ${i + 1} usa a imagem ${s.media.imageIndex}, que não existe`)
  })
  return errors
}
