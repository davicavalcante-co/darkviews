import { z } from 'zod'

export const MAX_DURATION_S = 1080 // 18 minutos: validar no front, na API e no worker

export const Role = z.enum(['admin', 'user'])
export const UserStatus = z.enum(['active', 'disabled'])
export type Role = z.infer<typeof Role>

const password = z.string().min(10, 'A senha precisa de pelo menos 10 caracteres').max(200)

export const LoginInput = z.object({ email: z.string().email(), password: z.string().min(1).max(200) })
export const SetupInput = z.object({ token: z.string().min(10), password })
export const CreateUserInput = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  password,
  role: Role.default('user'),
})
export const UpdateUserInput = z.object({ role: Role.optional(), status: UserStatus.optional() })

export type PublicUser = { id: string; email: string; name: string; role: Role }

// ---------- Fase 2: projetos ----------
export const Platform = z.enum(['youtube', 'instagram', 'kwai', 'tiktok'])
export type Platform = z.infer<typeof Platform>

const PLATFORM_HOSTS: Record<string, Platform> = {
  'youtube.com': 'youtube', 'youtu.be': 'youtube',
  'instagram.com': 'instagram',
  'kwai.com': 'kwai', 'kw.ai': 'kwai',
  'tiktok.com': 'tiktok',
}

// Lista de domínios permitidos: só links destas plataformas chegam ao yt-dlp.
export function detectPlatform(link: string): Platform | null {
  let url: URL
  try { url = new URL(link) } catch { return null }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  for (const [domain, platform] of Object.entries(PLATFORM_HOSTS)) {
    if (host === domain || host.endsWith('.' + domain)) return platform
  }
  return null
}

// Fontes liberadas de fábrica; o admin libera ou bloqueia outras na tabela `fonts`.
// Fontes de fábrica (todas do Google Fonts, baixadas na hora do render): boas para legenda e título de YouTube.
export const DEFAULT_FONTS = [
  'Montserrat', 'Poppins', 'Inter', 'Bebas Neue', 'Roboto', 'Anton', 'Oswald', 'Archivo Black', 'Bangers', 'Barlow Condensed',
  'Bricolage Grotesque', 'Bungee', 'DM Sans', 'Fira Sans', 'Fjalla One', 'Lato', 'League Spartan', 'Lilita One', 'Lexend',
  'Luckiest Guy', 'Manrope', 'Merriweather', 'Noto Sans', 'Nunito', 'Open Sans', 'Outfit', 'Permanent Marker', 'Playfair Display',
  'Raleway', 'Righteous', 'Roboto Condensed', 'Rubik', 'Russo One', 'Space Grotesk', 'Teko', 'Titan One', 'Ubuntu', 'Work Sans',
] as const
export const HighlightMode = z.enum(['palavra-chave', 'manual', 'karaokê'])

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024
export const VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm']

// Posição da legenda: vertical-horizontal ("bottom-center"); "bottom" e "middle" sozinhos valem centralizado.
export const CAPTION_POSITION = /^(top|middle|bottom)(-(left|center|right))?$/

export const NewProjectInput = z.object({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(5000),
  link: z.string().trim().max(500).optional().transform((v) => v || undefined)
    .refine((v) => !v || detectPlatform(v), 'Link precisa ser de YouTube, Instagram, Kwai ou TikTok'),
  targetDurationS: z.coerce.number().int().min(15).max(MAX_DURATION_S, 'Máximo de 18 minutos'),
  voiceBrief: z.string().trim().max(200).optional().transform((v) => v || undefined), // ex.: "mulher jovem, animada"
  voicePreset: z.string().trim().max(60).optional().transform((v) => v || undefined), // voz escolhida entre as opções do fornecedor em uso
  voiceTone: z.enum(['calma', 'natural', 'animada']).optional().or(z.literal('').transform(() => undefined)),
  bgColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().or(z.literal('').transform(() => undefined)),
  editStyle: z.enum(['auto', 'documentario', 'dinamico', 'revista', 'profundidade']).optional().or(z.literal('').transform(() => undefined)),
  useStock: z.enum(['0', '1']).optional().transform((v) => v !== '0'), // false: só as imagens do cliente, sem banco
  captions: z.string().default('[]').transform((s, ctx) => {
    try { return z.array(z.string().max(200)).parse(JSON.parse(s)) } catch {
      ctx.addIssue({ code: 'custom', message: 'Legendas inválidas' }); return z.NEVER
    }
  }),
})

export const ProjectStatus = z.enum(['queued', 'analyzing', 'scripting', 'talking_head', 'media', 'image_review', 'rendering', 'editing', 'in_approval', 'approved', 'failed'])
export const ReviewInput = z.object({ rejected: z.array(z.number().int().min(0)).max(2000) })
export type ProjectStatus = z.infer<typeof ProjectStatus>

export type ProgressEvent = {
  status: ProjectStatus
  job: { type: string; status: string; stage: string | null; progress: number; etaS: number | null; error: string | null } | null
}
export * from './plan'

// ---------- Fase 4: integrações ----------
export const IntegrationCategory = z.enum(['roteiro', 'voz', 'música', 'imagem', 'vídeo', 'banco_de_imagens', 'transcrição'])
export type IntegrationCategory = z.infer<typeof IntegrationCategory>

// tier: gratis = funciona sem chave (já conectada) · gratis_chave = gratuita, mas pede conta/chave · pago = cobra por uso.
export type Tier = 'gratis' | 'gratis_chave' | 'pago'
type CatalogItem = {
  provider: string; label: string; category: IntegrationCategory; tier: Tier; secrets: string[]
  config: Record<string, string>; choices?: Record<string, string[]>; builtIn?: boolean; priority: number; help: string; signup?: string
  tutorial: string[] // passo a passo do botão "Como conectar"
}
// Fornecedores com adaptador pronto. builtIn = ligado por padrão (não precisa de chave).
export const PROVIDERS: CatalogItem[] = [
  { provider: 'kokoro', label: 'Kokoro · voz neural', category: 'voz', tier: 'gratis', secrets: [], builtIn: true, priority: 20,
    config: { voice: 'pf_dora', speed: '1.0' }, choices: { voice: ['pf_dora', 'pm_alex', 'pm_santa'] },
    help: 'Voz neural em português do Brasil, com boa pronúncia (lh, nh, rr). Já vem pronta e pode ser usada em vídeos de clientes.',
    tutorial: ['Já vem pronta, sem cadastro.', 'Escolha a voz: Dora (feminina), Alex (masculina) ou Santa (masculina grave).', 'Clique em Testar e depois em Salvar.'] },
  { provider: 'piper', label: 'Piper · voz neural', category: 'voz', tier: 'gratis', secrets: [], builtIn: true, priority: 30,
    config: { voice: 'faber', speed: '1.08' }, choices: { voice: ['faber', 'cadu'] },
    help: 'Reserva: voz local mais simples (pode errar sons como lh e tr).',
    tutorial: ['Já vem pronta, sem cadastro.', 'Escolha a voz (Faber ou Cadu) e a velocidade da fala.', 'Clique em Testar e depois em Salvar.'] },
  { provider: 'omnivoice', label: 'OmniVoice · via Claude Code', category: 'voz', tier: 'gratis', secrets: [], priority: 15,
    config: { steps: '16', speed: '1.0' }, choices: { steps: ['8', '16', '32'] },
    help: 'Voz neural local com design de voz, dirigida pelo Claude Code (skill omnivoice + MCP). Atenção: o modelo padrão é NÃO COMERCIAL (CC-BY-NC).',
    signup: 'https://github.com/debpalash/OmniVoice-Studio',
    tutorial: ['Uso só para testes pessoais: o modelo de voz padrão do OmniVoice não pode ser usado em vídeos de clientes pagantes (licença não comercial).', 'Precisa ser instalado pelo administrador no computador (uma vez).', 'Depois de instalado, ligue aqui e descreva a voz desejada em Novo vídeo.'] },
  { provider: 'elevenlabs', label: 'ElevenLabs', category: 'voz', tier: 'pago', secrets: ['api_key'], priority: 10,
    config: { voice_id: '' }, help: 'A voz mais humana do mercado. Plano grátis com cota pequena.', signup: 'https://elevenlabs.io/app/settings/api-keys',
    tutorial: ['Crie uma conta em elevenlabs.io (o plano grátis dá alguns minutos por mês).', 'Abra Settings → API Keys e clique em "Create API Key". Copie a chave.', 'Em Voices → Voice Library, escolha uma voz em português e copie o Voice ID.', 'Cole a chave e o ID da voz aqui, ligue o card e clique em Testar.'] },
  { provider: 'openai_tts', label: 'OpenAI Voz', category: 'voz', tier: 'pago', secrets: ['api_key'], priority: 10,
    config: { voice: 'coral' }, choices: { voice: ['coral', 'alloy', 'ash', 'ballad', 'echo', 'nova', 'onyx', 'sage', 'shimmer', 'verse'] },
    help: 'Voz expressiva que segue o tom do roteiro (gpt-4o-mini-tts).', signup: 'https://platform.openai.com/api-keys',
    tutorial: ['Entre em platform.openai.com com sua conta (precisa de crédito na conta).', 'Abra API keys → "Create new secret key" e copie a chave.', 'Cole a chave aqui, escolha a voz e ligue o card.', 'Clique em Testar. A voz segue o tom do roteiro automaticamente.'] },
  { provider: 'google_tts', label: 'Google Cloud Voz', category: 'voz', tier: 'gratis_chave', secrets: ['api_key'], priority: 20,
    config: { voice: 'pt-BR-Neural2-B' }, choices: { voice: ['pt-BR-Neural2-B', 'pt-BR-Neural2-A', 'pt-BR-Neural2-C', 'pt-BR-Wavenet-B', 'pt-BR-Wavenet-A'] },
    help: 'Vozes neurais do Google. Cota mensal gratuita, depois cobra.', signup: 'https://console.cloud.google.com/apis/credentials',
    tutorial: ['Entre no console.cloud.google.com e crie (ou escolha) um projeto.', 'Em APIs e serviços → Biblioteca, ative "Cloud Text-to-Speech API".', 'Em APIs e serviços → Credenciais, clique em "Criar credenciais" → "Chave de API" e copie.', 'Recomendado: restrinja a chave só à Text-to-Speech API.', 'Cole a chave aqui, escolha a voz e clique em Testar.'] },
  { provider: 'macos_say', label: 'Voz do macOS', category: 'voz', tier: 'gratis', secrets: [], builtIn: true, priority: 90,
    config: { voice: 'Luciana' }, help: 'Reserva: só é usada se as outras vozes falharem.',
    tutorial: ['Já vem pronta. É só reserva: entra se as outras vozes falharem.', 'Não precisa fazer nada.'] },
  { provider: 'web', label: 'Imagens da web', category: 'banco_de_imagens', tier: 'gratis', secrets: [], builtIn: true, priority: 3, config: {},
    help: 'Fotos reais da internet (pessoas famosas, fatos, jogos). Já vem ligada. Atenção: essas imagens têm dono; a aprovação avisa quais são.',
    tutorial: ['Já vem pronta, sem cadastro.', 'Busca a foto exata do que é dito (ex.: "Vini Jr chorando").', 'Cada imagem aparece marcada com o aviso de direitos autorais na aprovação.'] },
  { provider: 'wikimedia', label: 'Wikimedia Commons', category: 'banco_de_imagens', tier: 'gratis', secrets: [], builtIn: true, priority: 5, config: {},
    help: 'Fotos reais de pessoas, lugares e eventos com licença livre. Já vem ligada.',
    tutorial: ['Já vem pronta, sem cadastro.', 'O crédito de cada foto entra sozinho na descrição do vídeo.'] },
  { provider: 'pexels', label: 'Pexels', category: 'banco_de_imagens', tier: 'gratis_chave', secrets: ['api_key'], priority: 10, config: {},
    help: 'Fotos e vídeos reais, de graça. Crie a chave em 1 minuto.', signup: 'https://www.pexels.com/api/new/',
    tutorial: ['Crie uma conta grátis em pexels.com.', 'Abra pexels.com/api/new, preencha o motivo de uso (ex.: "criação de vídeos") e envie.', 'Copie a chave que aparece na página.', 'Cole aqui, ligue o card e clique em Testar.'] },
  { provider: 'pixabay', label: 'Pixabay', category: 'banco_de_imagens', tier: 'gratis_chave', secrets: ['api_key'], priority: 20, config: {},
    help: 'Fotos e vídeos gratuitos.', signup: 'https://pixabay.com/api/docs/',
    tutorial: ['Crie uma conta grátis em pixabay.com.', 'Abra pixabay.com/api/docs: com a conta logada, a sua chave aparece na seção "Parameters" (key).', 'Copie a chave, cole aqui, ligue o card e clique em Testar.'] },
  { provider: 'openverse', label: 'Openverse', category: 'banco_de_imagens', tier: 'gratis', secrets: [], builtIn: true, priority: 60, config: {},
    help: 'Fotos com licença Creative Commons para uso comercial. Já vem conectado.',
    tutorial: ['Já vem pronto, sem cadastro.', 'Só usa fotos liberadas para uso comercial.', 'O crédito de cada foto entra sozinho na descrição do vídeo.'] },
  { provider: 'serper', label: 'Google Imagens (Serper)', category: 'banco_de_imagens', tier: 'gratis_chave', secrets: ['api_key'], priority: 90, config: {},
    help: 'Busca no Google Imagens. Reserva: só entra quando os bancos gratuitos não acham nada. Atenção: imagens do Google têm dono, use por sua conta.', signup: 'https://serper.dev/',
    tutorial: ['Entre em serper.dev e clique em "Sign up" com a sua conta Google.', 'No painel, copie a "API Key".', 'Cole aqui, ligue o card e clique em Testar.'] },
  { provider: 'elevenlabs_music', label: 'ElevenLabs Música', category: 'música', tier: 'pago', secrets: ['api_key'], priority: 10, config: {},
    help: 'Cria uma trilha original no estilo escolhido, do tamanho do vídeo. Liberada para uso comercial nos planos pagos.', signup: 'https://elevenlabs.io/app/settings/api-keys',
    tutorial: ['Use a mesma conta da ElevenLabs (plano pago para uso comercial).', 'Abra Settings → API Keys, crie uma chave e copie.', 'Cole a chave aqui, ligue o card e clique em Testar.', 'Em Novo vídeo, escolha o estilo: a trilha é composta sob medida.'] },
  { provider: 'jamendo', label: 'Jamendo', category: 'música', tier: 'gratis_chave', secrets: ['api_key'], priority: 20, config: {},
    help: 'Mais de 500 mil músicas de artistas independentes. Só usamos as liberadas para uso comercial.', signup: 'https://devportal.jamendo.com/',
    tutorial: ['Crie uma conta grátis em devportal.jamendo.com.', 'Clique em "Create an app" e dê um nome (ex.: Darkviews).', 'Copie o "Client ID" da app criada.', 'Cole aqui no campo da chave, ligue o card e clique em Testar.'] },
  { provider: 'openverse_audio', label: 'Openverse Áudio', category: 'música', tier: 'gratis', secrets: [], builtIn: true, priority: 30, config: {},
    help: 'Músicas Creative Commons liberadas para uso comercial (Jamendo, Freesound, ccMixter e outros). Já vem conectado.',
    tutorial: ['Já vem pronto, sem cadastro.', 'Só usa músicas liberadas para uso comercial.', 'O crédito da música entra na descrição do vídeo.'] },
  { provider: 'local_music', label: 'Músicas locais', category: 'música', tier: 'gratis', secrets: [], builtIn: true, priority: 50, config: {},
    help: 'Suas próprias músicas (com licença de uso). Reserva: entra quando as outras fontes não acham nada.',
    tutorial: ['Clique em "Enviar músicas" aqui embaixo e escolha arquivos MP3, M4A ou WAV.', 'Use só músicas com licença para uso comercial (bibliotecas pagas ou faixas livres de royalties).', 'Uma faixa é sorteada por vídeo e fica baixinha, por baixo da narração.'] },
]

export const IntegrationUpdate = z.object({
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(100),
  config: z.record(z.string().max(200)).default({}),
  // Só as chaves enviadas são trocadas; string vazia apaga.
  secrets: z.record(z.string().max(500)).default({}),
})

// ---------- Fase 5: edição ----------
export const Part = z.enum(['video', 'caption', 'title', 'description', 'keywords'])
export type Part = z.infer<typeof Part>
export const MetaField = z.enum(['title', 'description', 'keywords'])

export const MetadataInput = z.object({ value: z.string().max(5000) })
export const RestoreInput = z.object({ version: z.number().int().positive() })
export const ChangeRequestInput = z.object({
  part: Part,
  frameTimeS: z.number().min(0).max(MAX_DURATION_S).nullable().default(null),
  type: z.enum(['trocar_imagem', 'mudar_texto', 'mudar_ritmo', 'outro']).default('outro'),
  text: z.string().trim().min(1).max(1000),
})
export const RegenInput = z.object({ part: Part })

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/)
export const CaptionSegmentInput = z.object({
  startS: z.number().min(0).max(MAX_DURATION_S),
  endS: z.number().min(0).max(MAX_DURATION_S),
  text: z.string().trim().min(1).max(200),
  highlights: z.array(z.number().int().min(0)).max(50),
}).refine((s) => s.endS > s.startS, 'Fim da legenda precisa ser depois do início')
export const CaptionTrackInput = z.object({
  fontFamily: z.string().trim().min(1).max(60), // conferida contra as fontes liberadas no servidor
  fontWeight: z.union([z.literal(400), z.literal(700), z.literal(900)]),
  size: z.number().int().min(24).max(140),
  color: hex,
  highlightColor: hex,
  highlightMode: HighlightMode,
  position: z.string().regex(CAPTION_POSITION),
  outline: z.boolean().default(true),
  segments: z.array(CaptionSegmentInput).max(2000),
})
export * from './cuts'
export * from './claude-usage'

// ---------- Trilha sonora: estilos (termos de busca em inglês) ----------
export const MUSIC_STYLES = [
  { id: 'auto', label: 'Automático', tags: 'background' }, { id: 'lofi', label: 'Lo-fi', tags: 'lofi chill' },
  { id: 'eletronica', label: 'Eletrônica', tags: 'electronic' }, { id: 'rock', label: 'Rock', tags: 'rock' },
  { id: 'classica', label: 'Clássica', tags: 'classical piano' }, { id: 'cinematica', label: 'Cinema', tags: 'cinematic' },
  { id: 'epica', label: 'Épica', tags: 'epic orchestral' }, { id: 'acustica', label: 'Acústica', tags: 'acoustic guitar' },
  { id: 'corporativa', label: 'Corporativa', tags: 'corporate' }, { id: 'hiphop', label: 'Hip hop', tags: 'hip hop beat' },
  { id: 'jazz', label: 'Jazz', tags: 'jazz' }, { id: 'ambiente', label: 'Ambiente', tags: 'ambient' },
  { id: 'suspense', label: 'Suspense', tags: 'suspense dark' }, { id: 'none', label: 'Sem trilha', tags: '' },
] as const

// ---------- Voz desejada: opções prontas por fornecedor de voz ----------
export const VOICE_TONES = [
  { id: 'calma', label: 'Calma', speed: 1.0 },
  { id: 'natural', label: 'Natural', speed: 1.1 },
  { id: 'animada', label: 'Animada', speed: 1.2 },
] as const
export const VOICE_PRESETS: Record<string, { id: string; label: string }[]> = {
  kokoro: [{ id: 'pf_dora', label: 'Dora - Mulher' }, { id: 'pm_alex', label: 'Alex - Homem' }, { id: 'pm_santa', label: 'Santa - Homem, voz grave' }],
  piper: [{ id: 'faber', label: 'Faber - Homem' }, { id: 'cadu', label: 'Cadu - Homem jovem' }],
  openai_tts: [{ id: 'coral', label: 'Coral - Mulher, calorosa' }, { id: 'nova', label: 'Nova - Mulher jovem' }, { id: 'shimmer', label: 'Shimmer - Mulher, suave' }, { id: 'onyx', label: 'Onyx - Homem, voz grave' }, { id: 'echo', label: 'Echo - Homem' }, { id: 'ash', label: 'Ash - Homem jovem' }],
  google_tts: [{ id: 'pt-BR-Neural2-A', label: 'Neural2-A - Mulher' }, { id: 'pt-BR-Neural2-C', label: 'Neural2-C - Mulher' }, { id: 'pt-BR-Neural2-B', label: 'Neural2-B - Homem' }],
  elevenlabs: [{ id: '', label: 'Voz configurada na sua conta' }],
  macos_say: [{ id: 'Luciana', label: 'Luciana - Mulher' }],
  omnivoice: [{ id: 'mulher jovem, animada', label: 'Mulher jovem, animada' }, { id: 'homem maduro, calmo, voz grave', label: 'Homem maduro, calmo' }, { id: 'narradora de documentário, tom sério', label: 'Narradora de documentário' }],
}
