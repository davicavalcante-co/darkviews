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

## Instalar em outro Mac (passo a passo)

Precisa de: um Mac com chip Apple (M1 ou mais novo), internet e uns **15 GB livres**. Leva de 20 a 40 minutos na primeira vez.

1. Copie a pasta inteira do Corte Final para o Mac (ou baixe do GitHub).
2. Dê **dois cliques** em `Instalar Corte Final`.
   - Se o Mac avisar que o arquivo é de fonte desconhecida: clique com o botão direito → **Abrir** → **Abrir**.
   - Se pedir a senha do Mac, digite (é o Homebrew instalando programas).
   - Se abrir uma janela da Apple pedindo para instalar ferramentas, aceite e, quando terminar, dê dois cliques no instalador de novo.
3. No fim, ele abre o **login do Claude**: entre com a sua conta.
4. Anote o **token de primeiro acesso** que aparece no final.
5. Dê **dois cliques** em `Ligar Corte Final`. O navegador abre sozinho.
6. Na tela de login, aba **Primeiro acesso**: cole o token e crie a senha do admin.
7. Na aba **Vozes**, clique em **Ligar VoiceStudio** e depois em **Aceitar licença do modelo** (uso pessoal). A primeira voz demora uns 5 minutos (o modelo baixa uma vez só).

Pronto. Nos próximos dias, só o passo 5.

### O que o instalador faz sozinho

| O quê | Onde fica |
| --- | --- |
| Homebrew, Node, pnpm, FFmpeg com legendas, yt-dlp, Python 3.11, uv, Claude Code | programas do Mac (Homebrew) |
| Bibliotecas do Corte Final | `node_modules/` |
| Arquivo `.env` com chave de criptografia nova | `.env` |
| Banco de dados | `data/app.db` |
| Vozes Kokoro e Piper | `.venv-kokoro/`, `.venv-tts/` |
| VoiceStudio (aba Vozes), na versão testada com o Corte Final | `vendor/voicestudio/` |
| Skill do OmniVoice | já vem no projeto, em `.claude/skills/` |

Pode rodar o instalador de novo quando quiser: o que já está instalado é pulado.

**Baixa sozinho no primeiro uso** (grande demais para ir no projeto): modelos de voz (Kokoro, Piper, VoiceStudio ~2,4 GB) e as fontes das legendas. Depois ficam salvos e não baixam de novo.

**Precisa de internet para criar vídeos:** o Claude (roteiro), os bancos de imagens e de música e os links de referência.

### Instalação manual (se preferir o terminal)

```bash
./scripts/instalar.sh
```

Peças separadas: `pnpm install`, `pnpm run db:setup`, `pnpm run omnivoice:setup`, `pnpm dev`.

## Render

As legendas queimadas precisam de FFmpeg com libass. O `ffmpeg` comum do Homebrew não tem; o `ffmpeg-full` tem e é usado automaticamente se estiver instalado:

```bash
brew install ffmpeg-full
```

Cada render guarda também uma cópia sem legenda (`vN-sem-legenda.mp4`), usada nos cortes verticais. Vídeos renderizados antes da Fase 6 precisam ser renderizados de novo antes de aprovar.

Para outro caminho, defina `FFMPEG_PATH` no `.env`. Músicas de fundo: coloque arquivos MP3/M4A com licença de uso em `storage/music`.

## Voz gratuita (Piper)

A voz padrão é o **Piper**, uma voz neural em português do Brasil que roda no próprio computador, sem chave e sem custo. Instale uma vez:

```bash
pnpm run tts:setup
```

As vozes (Faber e Cadu, ~60 MB cada) são baixadas sozinhas na primeira fala, para `storage/voices`. Se o Piper não estiver instalado, o sistema usa a voz do macOS como reserva.

## OmniVoice via Claude Code (skill + MCP)

A skill [`omnivoice`](.claude/skills/omnivoice/ORIGEM.md) está em `.claude/skills/`. Quando a integração **OmniVoice** está ligada e em primeiro lugar na lista de vozes, a etapa "Gerando áudio" passa pelo Claude Code: ele carrega a skill, conecta no MCP do OmniVoice, cria a voz que o cliente descreveu em **Voz desejada** (Novo vídeo) e narra cada cena. Os áudios são gravados em arquivo, sem passar pelo contexto do Claude. Se o OmniVoice falhar, o vídeo usa a próxima voz (Piper).

O instalador já instala em `vendor/voicestudio`. Para instalar só ele (~1,6 GB agora e ~2,4 GB do modelo no primeiro uso):

```bash
pnpm run omnivoice:setup
```

Ligar e desligar o servidor local (porta 3900):

```bash
pnpm run omnivoice:start
```
```bash
pnpm run omnivoice:stop
```

Licenças: a skill é MIT; o OmniVoice Studio (programa) é AGPL-3.0 e roda separado. **Atenção: o modelo de voz padrão `k2-fsa/OmniVoice` é NÃO COMERCIAL (CC-BY-NC; Higgs Audio 2; Meta Llama 3)** e só gera voz depois que a licença dele e a do `eustlb/higgs-audio-v2-tokenizer` são aceitas no Model Catalogue do VoiceStudio. Uso pessoal; não use em vídeos de clientes pagantes.

## Claude via MCP

`apps/mcp` é um servidor MCP do Corte Final: o Claude cria e acompanha vídeos por conversa (`criar_video`, `listar_projetos`, `status_projeto`, `ver_roteiro`, `pedir_alteracao`, `regerar_parte`, `uso_claude`). Ele age como o usuário de `CORTE_FINAL_EMAIL` (no `.env`), com as mesmas permissões do site.

- **Claude Code:** abra esta pasta no Claude Code. O `.mcp.json` já registra `corte-final` e `omnivoice`; aprove os dois na primeira vez.
- **App Claude (Desktop):** Integrações → Claude · MCP → "Como conectar no app Claude" mostra o trecho de configuração.

## Integrações

Já vêm conectadas, sem chave: **Piper** (voz), **Openverse** (fotos Creative Commons) e **músicas locais**.

- **Admin → Integrações (padrão):** o que vale para todos os usuários.
- **Integrações** (menu lateral, para todos): cada usuário pode usar as próprias contas, grátis ou pagas (Pexels, Pixabay, ElevenLabs, OpenAI Voz, Google Cloud Voz). O que ele não configurar segue o padrão do admin. As chaves de um usuário só servem para os vídeos dele.

## Logs

Admin → Logs mostra tudo que entra, sai e falha: requisições da API (método, rota, status e tempo, sem corpo nem cookies), jobs do worker, chamadas ao Claude e falhas de integração, com a pilha de erro. Os registros com mais de 30 dias são apagados sozinhos.

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
