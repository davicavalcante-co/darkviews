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
export const DEFAULT_FONTS = ['Montserrat', 'Poppins', 'Inter', 'Bebas Neue', 'Roboto'] as const
export const HighlightMode = z.enum(['palavra-chave', 'manual', 'karaokê'])

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024
export const VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm']

export const NewProjectInput = z.object({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(5000),
  link: z.string().trim().max(500).optional().transform((v) => v || undefined)
    .refine((v) => !v || detectPlatform(v), 'Link precisa ser de YouTube, Instagram, Kwai ou TikTok'),
  targetDurationS: z.coerce.number().int().min(15).max(MAX_DURATION_S, 'Máximo de 18 minutos'),
  fontFamily: z.string().trim().min(1).max(60), // conferida contra as fontes liberadas no servidor
  highlightMode: HighlightMode,
  captions: z.string().default('[]').transform((s, ctx) => {
    try { return z.array(z.string().max(200)).parse(JSON.parse(s)) } catch {
      ctx.addIssue({ code: 'custom', message: 'Legendas inválidas' }); return z.NEVER
    }
  }),
})

export const ProjectStatus = z.enum(['queued', 'analyzing', 'scripting', 'media', 'rendering', 'editing', 'in_approval', 'approved', 'failed'])
export type ProjectStatus = z.infer<typeof ProjectStatus>

export type ProgressEvent = {
  status: ProjectStatus
  job: { type: string; status: string; stage: string | null; progress: number; etaS: number | null; error: string | null } | null
}
export * from './plan'

// ---------- Fase 4: integrações ----------
export const IntegrationCategory = z.enum(['roteiro', 'voz', 'música', 'imagem', 'vídeo', 'banco_de_imagens', 'transcrição'])
export type IntegrationCategory = z.infer<typeof IntegrationCategory>

type CatalogItem = { provider: string; label: string; category: IntegrationCategory; secrets: string[]; config: Record<string, string>; builtIn?: boolean; help: string }
// Fornecedores com adaptador pronto. builtIn = roda local, sem chave, ligado por padrão.
export const PROVIDERS: CatalogItem[] = [
  { provider: 'pexels', label: 'Pexels', category: 'banco_de_imagens', secrets: ['api_key'], config: {}, help: 'Fotos e vídeos gratuitos. Chave em pexels.com/api.' },
  { provider: 'pixabay', label: 'Pixabay', category: 'banco_de_imagens', secrets: ['api_key'], config: {}, help: 'Fotos e vídeos gratuitos. Chave em pixabay.com/api/docs.' },
  { provider: 'elevenlabs', label: 'ElevenLabs', category: 'voz', secrets: ['api_key'], config: { voice_id: '' }, help: 'Locução natural. Informe o voice_id da voz escolhida.' },
  { provider: 'macos_say', label: 'Voz do macOS', category: 'voz', secrets: [], config: { voice: 'Luciana' }, builtIn: true, help: 'Gratuita e local, qualidade básica.' },
  { provider: 'local_music', label: 'Músicas locais', category: 'música', secrets: [], config: {}, builtIn: true, help: 'Usa arquivos MP3/M4A da pasta storage/music (com licença de uso).' },
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
  position: z.enum(['bottom', 'middle']),
  segments: z.array(CaptionSegmentInput).max(2000),
})
export * from './cuts'
export * from './claude-usage'
