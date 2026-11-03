# Corte Final

Aplicação local que cria vídeos a partir de prompt, link de referência e imagens, e gera cortes 9:16. A especificação completa está em [SPEC.md](SPEC.md).

**Estado atual: Fase 7 (todas as fases do SPEC).**
- Fase 1: monorepo, banco, autenticação, papéis e tela de login.
- Fase 2: Novo vídeo (prompt, link com detecção de plataforma, vídeo e imagens com legenda e ordem), uploads com checagem do tipo real, fila de jobs com lock otimista, ingestão (yt-dlp + ffprobe) e tela de Andamento em tempo real (SSE). 
- Fase 3: análise da referência (cortes de cena e quadros-chave com FFmpeg, transcrição opcional com whisper.cpp, perfil de estilo pelo Claude) e roteiro com título, descrição, palavras-chave e plano de cenas validado.
- Fase 4: integrações (Pexels, Pixabay, ElevenLabs, voz do macOS, músicas locais) com chaves criptografadas, escolha de imagens pelo Claude, locução, trilha e render 1920x1080 30 fps com Ken Burns e legendas ASS com Google Fonts.
- Fase 5: tela de Edição em cinco partes (Vídeo com linha do tempo e pedidos por quadro, Legenda com texto/tempo/fonte/destaques, Título, Descrição, Palavras-chave). Cada parte tem histórico de versões (voltar atrás cria versão nova) e pode ser regerada sozinha pelo Claude.
- Fase 6: aprovação e cortes verticais 9:16 (Shorts até 60 s, Reels até 90 s, TikTok até 180 s, Stories em partes de 15 s), com escolha do trecho e do enquadramento e legenda remontada para a tela vertical. Cada corte pode ser refeito com outro enquadramento.
- Fase 7: Painel (indicadores de produção e uso do Claude com tokens, percentuais, contagem regressiva, renovação do plano e avisos), checagem do Claude a cada 2 minutos, Admin completo (usuários, integrações, fontes, plano e limites, auditoria) e testes de permissão cobrindo todas as rotas de admin.

Contas de teste para desenvolvimento: `pnpm run db:demo` (senhas em `packages/shared/src/demo.ts`; apague essas contas antes de uso real).

## Requisitos

- Node 20+ e pnpm (`npm i -g pnpm`)
- FFmpeg e yt-dlp (usados a partir da Fase 2):

```bash
brew install ffmpeg yt-dlp
```

No Windows: `winget install Gyan.FFmpeg yt-dlp.yt-dlp`. No Linux: `sudo apt install ffmpeg` e `pipx install yt-dlp`.

## Instalação

```bash
pnpm install
cp .env.example .env          # depois gere a MASTER_KEY: openssl rand -hex 32
pnpm run db:setup             # cria ./data/app.db e o admin do seed
pnpm dev                      # web em http://localhost:5173, API em 127.0.0.1:3333
```

O `db:setup` imprime um **token de primeiro acesso**. Abra o site, vá na aba "Primeiro acesso", cole o token e defina a senha do admin (e-mail em `ADMIN_EMAIL`). O token vale uma vez só; para gerar outro, rode `pnpm run db:seed` de novo enquanto o admin não tiver senha.

## Render

As legendas queimadas precisam de FFmpeg com libass. O `ffmpeg` comum do Homebrew não tem; o `ffmpeg-full` tem e é usado automaticamente se estiver instalado:

```bash
brew install ffmpeg-full
```

Cada render guarda também uma cópia sem legenda (`vN-sem-legenda.mp4`), usada nos cortes verticais. Vídeos renderizados antes da Fase 6 precisam ser renderizados de novo antes de aprovar.

Para outro caminho, defina `FFMPEG_PATH` no `.env`. Músicas de fundo: coloque arquivos MP3/M4A com licença de uso em `storage/music`.

## Integrações

Em Admin → Integrações, cadastre as chaves (Pexels é gratuita e é a melhor para começar). Sem nenhum banco de imagens, as cenas sem foto sua viram quadros de texto. A voz do macOS funciona sem chave.

## Claude

O worker usa o login do Claude Code desta máquina (Agent SDK). Antes do `pnpm dev`, confirme que está logado:

```bash
claude auth status
```

Se não estiver, rode `claude` e use `/login`. Sem login, os jobs ficam **pausados** com o aviso "Faça login no Claude Code" e voltam sozinhos depois. Limite de uso atingido também pausa e retoma no horário de reinício.

Transcrição (opcional): baixe um modelo do whisper.cpp e aponte `WHISPER_MODEL` no `.env`:

```bash
curl -L -o ~/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

## Estrutura

| Pasta | O que é |
| --- | --- |
| `apps/web` | React + Vite. Só fala com a API local via proxy `/api`. |
| `apps/api` | Fastify. Sessão por cookie httpOnly, Argon2id, CSRF, limite de login, checagem de papel. |
| `apps/worker` | Processo dos jobs pesados (consome a tabela `jobs` a partir da Fase 2). |
| `packages/db` | Schema Prisma (todas as tabelas do SPEC) e o client. |
| `packages/shared` | Validações Zod e tipos usados pelo front e pela API. |

Para trocar para PostgreSQL: mude `provider` em `packages/db/prisma/schema.prisma` e a `DATABASE_URL`.

## Testes

```bash
pnpm test
```

Cobrem: 403 para usuário comum nas rotas de admin, 401 sem sessão, último admin protegido, CSRF/origem, cookie httpOnly + SameSite=Strict, primeiro acesso de uso único e limite de tentativas de login.

## Backup

Copie `./data/app.db` e a pasta `./storage` com a aplicação parada. **Guarde o `.env` (MASTER_KEY) separado do backup**: sem ela as chaves de integração não podem ser lidas, e com ela junto o backup deixa de ser seguro.
