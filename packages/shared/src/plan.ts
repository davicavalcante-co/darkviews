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
  transition: z.enum(['cut', 'punch_in', 'punch_out', 'fade', 'zoom_through', 'slide_left', 'slide_right', 'slide_up', 'slide_down', 'whip', 'slide', 'zoom'])
    .describe('Entrada da cena. cut = corte seco; punch_in/punch_out = corte seco com zoom, como trocar de câmera; zoom_through = a câmera entra na imagem anterior e revela esta; slide_* = desliza rápido para o lado/cima/baixo; whip = chicote rápido com borrão; fade = dissolve'),
  motion: z.enum(['ken_burns', 'parallax', 'cutout', 'snap_zoom', 'static'])
    .describe('Movimento da imagem (só fotos). ken_burns = zoom e pan lentos; parallax = objeto e fundo em velocidades diferentes (2.5D), melhor com um objeto/pessoa em destaque; cutout = recorte de revista em papel, com stop-motion; snap_zoom = zoom rápido de ênfase; static = parada'),
  easing: z.enum(['ease_in_out', 'ease_in', 'ease_out', 'linear']).describe('Curva do movimento: ease_in_out = suave nas pontas (padrão); ease_in = começa lento e acelera; ease_out = começa rápido e desacelera'),
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
    if (s.media.type === 'text_card' && !s.media.text.trim()) errors.push(`Cena ${i + 1} é um quadro de texto vazio: escreva o texto ou use uma imagem`)
    if (s.media.type === 'user_image' && s.media.imageIndex >= imageCount) errors.push(`Cena ${i + 1} usa a imagem ${s.media.imageIndex}, que não existe`)
  })
  return errors
}
