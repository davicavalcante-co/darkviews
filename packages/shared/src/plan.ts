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

const Moment = z.object({ timeS: z.number().describe('Segundo do vídeo'), text: z.string() })
// Análise completa de um vídeo (aba Análise): tudo o que dá para aprender e copiar do estilo.
export const AnalysisDetails = z.object({
  summary: z.string().describe('Do que o vídeo trata e por que funciona, em 2 a 4 frases'),
  audience: z.string().describe('Para quem é e o que prende esse público'),
  hook: z.object({ timeS: z.number(), text: z.string().describe('O gancho, como foi dito ou mostrado'), why: z.string().describe('Por que ele prende') }),
  script: z.object({
    structure: z.array(z.string()).describe('Partes do roteiro na ordem, com o tempo aproximado de cada uma'),
    techniques: z.array(z.string()).describe('Técnicas de roteiro usadas: perguntas abertas, curiosidades, histórias, viradas, chamadas para imaginar...'),
    keyLines: z.array(Moment).describe('Falas mais marcantes, com o segundo'),
  }),
  speech: z.object({ tone: z.string(), pace: z.string().describe('Velocidade e variação da fala'), pauses: z.string().describe('Onde e como usa pausas e silêncio') }),
  highlights: z.array(Moment).describe('Destaques de texto, ênfases e momentos de impacto'),
  editing: z.object({ cutsPerMinute: z.number(), rhythm: z.string(), notes: z.array(z.string()) }),
  motion: z.array(z.string()).describe('Movimentos de câmera e de imagem: zoom, pan, parallax, shake...'),
  transitions: z.array(z.string()).describe('Transições usadas, quando e com que frequência'),
  design: z.object({ palette: z.array(z.string()).describe('Cores em hex'), typography: z.string(), elements: z.array(z.string()).describe('Elementos gráficos: faixas, setas, molduras, ícones...') }),
  dynamics: z.string().describe('Como o vídeo mantém a atenção do começo ao fim'),
  audio: z.object({ music: z.string(), effects: z.string() }),
  callToAction: z.string(),
  timeline: z.array(Moment).describe('Linha do tempo dos principais momentos'),
  howToRecreate: z.array(z.string()).describe('Passos práticos para fazer um vídeo novo neste estilo'),
})
export type AnalysisDetails = z.infer<typeof AnalysisDetails>

const Media = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_image'), imageIndex: z.number().int().min(0).describe('Índice da imagem enviada pelo usuário') }),
  z.object({
    type: z.literal('stock'),
    kind: z.enum(['image', 'video']),
    queries: z.array(z.string()).min(1).max(8).describe('Termos de busca do mais fiel ao mais genérico: 1 ou 2 por nível, nível 1 primeiro'),
    levels: z.array(z.number().int().min(1).max(4)).max(8).optional().describe('Nível de cada termo, na mesma ordem (1 = exato … 4 = pouca relação)'),
    orientation: z.enum(['landscape', 'portrait', 'square']),
  }),
  z.object({ type: z.literal('user_video'), note: z.string().describe('O que o vídeo do cliente mostra neste trecho') }),
  z.object({ type: z.literal('text_card'), text: z.string().describe('Quadro de texto 2D quando nenhuma imagem serve') }),
  // Vídeo com falas: a fala exata entra com o corte original (áudio e imagem), enviado pela pessoa.
  z.object({ type: z.literal('quote'), text: z.string().describe('A fala exata, palavra por palavra'), source: z.string().describe('De onde é: filme/série/vídeo, personagem e, se souber, episódio ou cena') }),
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
  if (end > MAX_DURATION_S) errors.push(`O vídeo passa de 60 minutos (${end}s)`)
  // Tempo aproximado: qualidade vem antes; só recusa muito curto ou acima do máximo.
  if (end < targetDurationS * 0.7) {
    errors.push(`Duração total ${end}s longe da duração pedida (${targetDurationS}s; pode passar, mas não ficar muito abaixo)`)
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

// Brainstorm: ideias de vídeo para um nicho.
export const BrainstormResult = z.object({
  audience: z.string().describe('Quem assiste esse nicho e o que essa pessoa procura'),
  trends: z.array(z.string()).describe('Assuntos e formatos em alta nesse nicho agora'),
  ideas: z.array(z.object({
    title: z.string().describe('Título forte para YouTube'),
    hook: z.string().describe('Primeira frase do vídeo, que prende nos primeiros 5 s'),
    angle: z.string().describe('O ângulo ou a história do vídeo, em 1 a 2 frases'),
    why: z.string().describe('Por que esse vídeo tende a funcionar'),
    durationMin: z.number().describe('Duração sugerida em minutos'),
    outline: z.array(z.string()).describe('Tópicos do roteiro na ordem'),
  })).min(5).max(15),
})
export type BrainstormResult = z.infer<typeof BrainstormResult>
