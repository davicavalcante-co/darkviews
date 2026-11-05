# Darkviews — Prompt de construção

Nov 3, 2026 · @Davi Cavalcante

## Visão geral

O Darkviews é uma aplicação local (localhost) que cria vídeos de até 18 minutos a partir de um prompt, de um link de referência e de imagens enviadas pelo usuário. Depois do vídeo pronto, ele gera cortes verticais 9:16 para Shorts, Reels, TikTok e Stories. O Claude roda na máquina do cliente e faz o planejamento: analisa a referência, escreve o roteiro, escolhe as cenas e monta o plano de edição. A renderização fica a cargo do FFmpeg.

Como usar este documento:

1. Copie o prompt da seção seguinte e cole no Claude Code, dentro de uma pasta vazia do seu computador.
2. As outras seções são o detalhamento que o prompt manda seguir: permissões, modelagem de dados, segurança, integrações e o guia de imagens reais. Mantenha-as juntas com o prompt (por exemplo, salvando este documento como `SPEC.md` na mesma pasta).
3. Revise cada etapa entregue antes de pedir a próxima. O prompt já divide o trabalho em fases.

Fluxo do vídeo dentro do sistema: **Referência e imagens → Análise → Roteiro e plano → Criação (render) → Edição por partes → Aprovação → Cortes verticais → Entrega.**

## Prompt de construção

Cole o texto abaixo no Claude Code, numa pasta vazia que já contenha este documento salvo como `SPEC.md`.

```markdown
Você vai construir o "Darkviews", uma aplicação web que roda em localhost e cria vídeos a partir de prompt, link de referência e imagens enviadas. Leia o arquivo SPEC.md inteiro antes de começar: ele define permissões, modelagem de dados, segurança, integrações e regras de negócio. Em caso de dúvida, o SPEC.md vale mais que este prompt.

## Stack
- Monorepo com pnpm: apps/web (React + Vite + TypeScript), apps/api (Node 20 + Fastify + TypeScript), apps/worker (processo separado para jobs pesados), packages/shared (tipos e validações com Zod).
- Banco: SQLite com Prisma (arquivo em ./data/app.db). Deixe o schema pronto para trocar por PostgreSQL só mudando o provider.
- Fila de jobs: tabela `jobs` no próprio banco, consumida pelo worker com lock otimista (sem Redis).
- Mídia: FFmpeg e ffprobe para análise, render e cortes; yt-dlp para baixar a referência quando o link for de YouTube, Instagram, Kwai ou TikTok.
- IA: Claude Agent SDK (TypeScript) rodando no backend com o login do Claude da máquina do cliente. Nenhuma chamada ao Claude sai do navegador.
- Arquivos: pasta ./storage (uploads, referências, renders, cortes), servida só por rotas autenticadas da API.

## Regras que não podem ser quebradas
1. Nenhuma chave de API, token, segredo ou caminho de arquivo interno pode chegar ao frontend. O navegador só fala com a API local.
2. Chaves de integrações externas ficam criptografadas no banco (AES-256-GCM) com a chave mestra do arquivo .env, que nunca é versionado.
3. Autenticação por sessão com cookie httpOnly, SameSite=Strict, senha com Argon2id, proteção CSRF e limite de tentativas de login.
4. Toda rota checa o papel do usuário (admin ou usuário comum) no servidor, não só na interface.
5. Duração máxima do vídeo final: 18 minutos (1080 segundos). Valide no frontend e de novo na API e no worker.
6. Uploads: só imagens (jpg, png, webp) até 20 MB cada e vídeos (mp4, mov, webm) até 2 GB. Confira o tipo real do arquivo pelos primeiros bytes, não só pela extensão.

## Papéis
- Admin: gerencia usuários, integrações, chaves, limites de uso, fontes disponíveis, plano do Claude e vê todos os projetos.
- Usuário comum: cria e edita os próprios projetos, aprova os próprios vídeos e baixa os cortes. Não vê chaves nem configurações.
A tabela completa de permissões está no SPEC.md.

## Telas
1. Login.
2. Painel: indicadores de produção (em análise, criando, em edição, aguardando aprovação, cortes gerados, entregas por semana) e o bloco de uso do Claude (tokens usados, uso restante da sessão e da semana, tempo até a sessão reiniciar, dias até o plano renovar, status de disponibilidade e avisos).
3. Novo vídeo: campo de prompt, campo de link de referência (detecta a plataforma), upload de vídeo de referência, upload de várias imagens com legenda/ordem, duração (até 18 min), formato, fonte das legendas (Google Fonts) e estilo de destaque.
4. Andamento: mostra a etapa atual (Na fila, Analisando referência, Escrevendo roteiro, Buscando imagens, Gerando áudio, Criando vídeo, Pronto), o percentual e a estimativa de tempo restante. Atualização em tempo real por Server-Sent Events.
5. Edição: o vídeo é dividido em cinco partes editáveis separadamente: Vídeo (timeline com quadros, marcadores e pedido de alteração por quadro), Legenda (texto, tempo, fonte, palavras em destaque), Título, Descrição e Palavras-chave. Cada parte tem histórico de versões e pode ser regerada sozinha pelo Claude.
6. Aprovação: aprovar gera os cortes 9:16 (YouTube Shorts até 60 s, Instagram Reels até 90 s, TikTok, Stories em partes de 15 s) com escolha de enquadramento.
7. Admin: usuários, integrações, fontes, plano e limites, log de auditoria.

## Pipeline de criação (worker)
1. Ingestão: baixar a referência (yt-dlp) ou receber o upload; ffprobe para metadados.
2. Análise: extrair quadros-chave e cortes de cena (FFmpeg scene detection), transcrever o áudio (integração de transcrição), e pedir ao Claude um "perfil de estilo": ritmo médio de cortes, enquadramentos, tipo de legenda, paleta, estrutura do roteiro.
3. Roteiro: o Claude escreve roteiro, título, descrição, palavras-chave e um plano de cenas em JSON validado com Zod (cada cena com tempo, texto, tipo de mídia, imagem do usuário ou termo de busca no banco de imagens).
4. Mídia: usar primeiro as imagens do usuário; depois bancos de imagens/vídeos; por último geração por IA. Gerar locução e trilha pelas integrações ativas.
5. Render: montar com FFmpeg (zoom suave em fotos, transições, legenda queimada em ASS com a fonte escolhida e palavras em destaque), exportar 1920x1080 30 fps.
6. Estimativa de tempo: calcular por etapa com base na duração alvo e na média dos últimos jobs gravada na tabela `job_metrics`; atualizar a cada etapa.

## Uso do Claude
Implemente o serviço `claudeUsage` como descrito na seção "Uso do Claude no dashboard" do SPEC.md. Grave o uso de tokens de cada chamada na tabela `claude_usage_events`. Se o Claude estiver indisponível, pause os jobs que dependem dele, mostre o aviso no Painel e retome sozinho quando voltar.

## Entrega por fases
Fase 1: estrutura do monorepo, banco, autenticação, papéis e tela de login.
Fase 2: Novo vídeo, uploads, fila de jobs e tela de Andamento com SSE.
Fase 3: análise da referência e roteiro com o Claude.
Fase 4: mídia, integrações e render.
Fase 5: Edição em cinco partes, legendas com Google Fonts e destaques.
Fase 6: Aprovação e cortes verticais.
Fase 7: Painel, uso do Claude, Admin e testes.
Ao final de cada fase: rode os testes, mostre como iniciar com `pnpm dev`, liste o que falta e espere minha confirmação antes da próxima.

Crie também: .env.example sem valores reais, seed com um admin (senha definida no primeiro acesso), README em português com instalação do FFmpeg e do yt-dlp, e testes de permissão garantindo que um usuário comum recebe 403 nas rotas de admin.
```

## Permissões

São dois papéis: **admin** e **usuário comum**. A checagem acontece sempre na API; esconder botões na interface é só conveniência.

| Ação | Usuário comum | Admin |
| --- | --- | --- |
| Criar vídeo (prompt, link, imagens) | Sim | Sim |
| Ver e editar projetos | Só os próprios | Todos |
| Editar vídeo, legenda, título, descrição, palavras-chave | Só os próprios | Todos |
| Aprovar vídeo e gerar cortes | Só os próprios | Todos |
| Baixar vídeo e cortes | Só os próprios | Todos |
| Excluir projeto | Só os próprios, antes da aprovação | Qualquer um |
| Ver Painel de produção | Números dos próprios projetos | Números de todos |
| Ver uso do Claude (tokens, sessão, plano) | Só o status e os avisos | Detalhado, com histórico |
| Cadastrar, ativar e testar integrações | Não | Sim |
| Ver ou alterar chaves de API | Não | Alterar sim; ver nunca (a chave aparece mascarada, ex.: `sk-…9f2a`) |
| Escolher fontes Google disponíveis para legendas | Usa as liberadas | Libera e bloqueia fontes |
| Definir limites (vídeos por dia, duração máxima até 18 min) | Não | Sim |
| Criar, desativar e trocar papel de usuários | Não | Sim |
| Ver log de auditoria | Não | Sim |

Regras extras:

- O sistema precisa ter sempre pelo menos um admin ativo; a API recusa rebaixar ou desativar o último.
- Toda ação de admin (mudar chave, papel, limite) grava uma linha em `audit_logs`.
- Um usuário comum que tenta abrir projeto de outra pessoa recebe 404, para não revelar que o projeto existe.

## Modelagem de dados

O centro do modelo é o **projeto**: cada projeto tem uma referência, várias imagens, um job de criação por vez e cinco partes editáveis com histórico (vídeo, legenda, título, descrição, palavras-chave). Todos os IDs são UUID; todas as tabelas têm `created_at` e `updated_at`.

| Tabela | Campos principais | Relações |
| --- | --- | --- |
| `users` | email (único), name, password\_hash, role (`admin` \| `user`), status (`active` \| `disabled`), last\_login\_at | 1:N projects, sessions, audit\_logs |
| `sessions` | user\_id, token\_hash, expires\_at, ip, user\_agent | N:1 users |
| `projects` | owner\_id, name, prompt, status (`queued` \| `analyzing` \| `scripting` \| `media` \| `rendering` \| `editing` \| `in_approval` \| `approved` \| `failed`), target\_duration\_s (≤ 1080), aspect (`16:9`), approved\_at | N:1 users; 1:1 references; 1:N assets, jobs, cuts |
| `references` | project\_id, source\_type (`link` \| `upload`), platform (`youtube` \| `instagram` \| `kwai` \| `tiktok` \| null), url, file\_path, duration\_s, style\_profile (JSON: ritmo, cortes/min, paleta, tipo de legenda, estrutura) | 1:1 projects |
| `assets` | project\_id, kind (`user_image` \| `stock_image` \| `stock_video` \| `ai_image` \| `ai_video` \| `voice` \| `music`), file\_path, mime, width, height, duration\_s, source\_provider, source\_id, license, attribution, sort\_order, user\_caption | N:1 projects; usado por scenes |
| `scripts` | project\_id, version, body (texto), scene\_plan (JSON validado), created\_by (`claude` \| user\_id) | N:1 projects |
| `scenes` | script\_id, index, start\_s, end\_s, narration, on\_screen\_text, asset\_id, search\_query, transition | N:1 scripts; N:1 assets |
| `video_versions` | project\_id, version, file\_path, duration\_s, render\_settings (JSON), is\_current | N:1 projects |
| `caption_tracks` | project\_id, version, font\_family (Google Fonts), font\_weight, size, color, highlight\_color, highlight\_mode (`palavra-chave` \| `manual` \| `karaokê`), position, is\_current | 1:N caption\_segments |
| `caption_segments` | track\_id, start\_s, end\_s, text, highlights (JSON: lista de trechos e índices) | N:1 caption\_tracks |
| `metadata_fields` | project\_id, field (`title` \| `description` \| `keywords`), version, value, is\_current, created\_by | N:1 projects |
| `change_requests` | project\_id, part (`video` \| `caption` \| `title` \| `description` \| `keywords`), frame\_time\_s, type, text, status (`open` \| `applied`), author\_id, applied\_in\_version | N:1 projects, users |
| `cuts` | project\_id, platform (`shorts` \| `reels` \| `tiktok` \| `stories`), part\_index, start\_s, end\_s, crop\_x (0–100), file\_path, status | N:1 projects |
| `jobs` | project\_id, type (`ingest` \| `analyze` \| `script` \| `media` \| `render` \| `cuts` \| `regen_part`), status (`queued` \| `running` \| `paused` \| `done` \| `failed`), stage, progress (0–100), eta\_s, started\_at, finished\_at, error, locked\_by, attempts | N:1 projects |
| `job_metrics` | job\_type, input\_duration\_s, elapsed\_s | usado para estimar o tempo |
| `integrations` | provider, category (`roteiro` \| `voz` \| `música` \| `imagem` \| `vídeo` \| `banco_de_imagens` \| `transcrição`), enabled, priority, config (JSON sem segredos), last\_test\_at, last\_test\_ok | 1:N integration\_secrets |
| `integration_secrets` | integration\_id, name, ciphertext, iv, auth\_tag, last4 | N:1 integrations |
| `fonts` | family, weights, enabled (escolhidas pelo admin), cached\_file\_path | usado por caption\_tracks |
| `claude_usage_events` | job\_id, model, input\_tokens, output\_tokens, cache\_read\_tokens, cache\_write\_tokens, created\_at | N:1 jobs |
| `claude_status` | checked\_at, available, reason, session\_used\_pct, session\_resets\_at, week\_used\_pct, week\_resets\_at | snapshot mais recente para o Painel |
| `settings` | key, value (ex.: `plan_renews_at`, `plan_name`, `max_duration_s`, `daily_video_limit`) | editadas só pelo admin |
| `audit_logs` | actor\_id, action, target\_type, target\_id, details (JSON sem segredos), ip | N:1 users |

Versões: editar uma parte cria uma nova linha com `version + 1` e marca a anterior como `is_current = false`. Assim dá para comparar e voltar atrás sem perder nada.

## Segurança: nada sensível no frontend

O navegador recebe só o que precisa mostrar. Chaves, tokens, caminhos de arquivo e respostas brutas das integrações ficam no servidor local.

**Onde cada coisa fica**

| Dado | Onde fica | O que o navegador recebe |
| --- | --- | --- |
| Chave mestra de criptografia | `.env` (fora do Git), lida só pela API e pelo worker | Nada |
| Chaves das integrações (voz, imagem, bancos de imagens) | `integration_secrets`, criptografadas com AES-256-GCM | Só os 4 últimos caracteres, para o admin conferir |
| Login do Claude | Credenciais do próprio Claude Code na máquina; usadas pelo Agent SDK no backend | Só o status: disponível ou não, e percentuais de uso |
| Senhas de usuários | `users.password_hash` com Argon2id | Nada |
| Sessão | Cookie httpOnly, Secure quando houver HTTPS, SameSite=Strict | O cookie, que o JavaScript não consegue ler |
| Arquivos de mídia | `./storage`, fora da pasta pública | URLs da API com ID (`/api/media/:id`) que checam dono e papel |
| Respostas das integrações | Logs do servidor, sem chaves | Só o resultado já tratado (imagem salva, áudio salvo) |

**Checklist para o build**

- [ ] Nenhuma variável com prefixo `VITE_` contém segredo (tudo com `VITE_` vai para o bundle do navegador).
- [ ] A API escuta só em `127.0.0.1` por padrão; abrir para a rede local exige configuração explícita do admin.
- [ ] CORS liberado só para a origem do próprio frontend.
- [ ] Validação de todas as entradas com Zod na API, inclusive o JSON que o Claude devolve.
- [ ] Links de referência passam por lista de domínios permitidos antes de chamar o yt-dlp, e o comando é montado com argumentos separados (sem concatenar texto no shell).
- [ ] Nomes de arquivo enviados são trocados por UUID ao salvar.
- [ ] Logs nunca imprimem chaves, cookies ou o corpo de requisições com segredos.
- [ ] `audit_logs` registra quem mudou chave, papel ou limite.
- [ ] Backup do banco e da pasta `storage` documentado no README; a chave mestra é guardada separada do backup.

Direitos de uso: o vídeo de referência serve para analisar estilo. O cliente precisa ter permissão para usar trechos dele no vídeo final; o sistema não deve reaproveitar imagens da referência por padrão.

## Integrações externas

Cada categoria tem uma interface única no backend (por exemplo, `VoiceProvider.synthesize(texto, voz)`), e cada fornecedor é um adaptador que o admin liga, desliga e ordena por prioridade. Se o primeiro falhar ou estourar a cota, o worker tenta o próximo. O Claude continua sendo o cérebro: ele escolhe o que pedir a cada integração.

| Categoria | Para que serve no vídeo | Opções | Observações |
| --- | --- | --- | --- |
| Roteiro e plano de cenas | Analisar a referência, escrever roteiro, título, descrição, palavras-chave e o JSON de cenas | Claude (padrão, local); opcional: outro modelo via API como segunda opinião | Sem custo extra no plano do cliente; o JSON passa por validação antes de seguir |
| Transcrição | Entender a fala da referência e gerar a base das legendas | whisper.cpp (local, gratuito), OpenAI transcrição, Deepgram, AssemblyAI | Comece pelo local; APIs ajudam em áudio ruim ou volume alto |
| Locução | Narração em português com voz natural | [ElevenLabs](https://elevenlabs.io/developers), OpenAI TTS, Azure Speech, Google Cloud TTS | Guarde a voz escolhida no projeto para manter consistência nas regravações |
| Música | Trilha de fundo no ritmo do vídeo | [Eleven Music](https://elevenlabs.io/docs/overview/capabilities/music) (faixas de 3 s a 5 min, plano pago), bibliotecas licenciadas (Epidemic Sound, Artlist, Pixabay Music) | Para vídeos acima de 5 min, emendar faixas ou usar biblioteca; confira a licença de uso comercial |
| Banco de imagens e vídeos reais | Fotos e trechos filmados reais para as cenas | [Pexels](https://www.pexels.com/api/documentation/) (gratuito, fotos e vídeos, 200 req/h e 20.000 req/mês por padrão), Pixabay, Unsplash (só fotos), Shutterstock, Getty Images / iStock, Storyblocks | Gratuitos pedem crédito ao autor; pagos dão mais variedade e licença mais clara para marcas |
| Geração de imagem | Imagens que não existem em banco (produto em cenário, ilustração) | OpenAI Images, Google Imagen (Gemini API), Black Forest Labs (FLUX), Stability AI, Ideogram (bom com texto na imagem) | Use para complementar, não para substituir fotos de pessoas reais |
| Geração de vídeo | Planos curtos animados (5 a 10 s) entre fotos e vídeos de banco | Google Veo (Gemini API), Runway, Luma, Kling | Caro e lento por segundo gerado; reserve para aberturas e transições |
| Avatar / apresentador | Pessoa digital falando o roteiro | HeyGen, Synthesia, D-ID | Precisa de consentimento quando o avatar imita alguém real |
| Upscale e limpeza | Melhorar imagens pequenas do usuário, remover fundo | Real-ESRGAN (local), remove.bg, Clipdrop | Rodar local quando possível para economizar |

Regras para todas as integrações:

- A chamada sai sempre do worker, nunca do navegador.
- Cada mídia baixada vira um `asset` com fornecedor, ID de origem, licença e texto de crédito. A descrição final do vídeo já sai com os créditos exigidos.
- O botão "Testar" do admin faz uma chamada mínima e grava `last_test_ok`, sem mostrar a resposta bruta.
- Preços e limites mudam com frequência: confira na página de cada fornecedor antes de contratar.

## Vídeos com imagens reais

Para sair do vídeo só com elementos 2D e 3D, o sistema precisa de três fontes de imagem real, nesta ordem de preferência: **suas próprias imagens**, **bancos de imagens e vídeos** e, só para completar, **imagens geradas por IA**. Abaixo está o que você precisa ter em mãos para começar.

### 1. Contas e chaves

- [ ] Uma conta gratuita na Pexels (fotos e vídeos) para começar sem custo.
- [ ] Pixabay como segunda opção gratuita.
- [ ] Se for produzir para marcas ou anúncios pagos: um banco pago com licença comercial clara (Shutterstock, Getty/iStock ou Storyblocks).
- [ ] Uma conta de locução (ElevenLabs ou similar) e uma fonte de música licenciada.
- [ ] FFmpeg, yt-dlp e whisper.cpp instalados na máquina.

### 2. Material próprio do cliente

- Fotos do produto, da equipe, do local, logotipo em PNG com fundo transparente.
- Resolução mínima de 1920×1080 para o vídeo horizontal. Para os cortes verticais, prefira fotos com o assunto no centro ou com margem dos lados, porque o corte 9:16 aproveita só uma faixa da imagem.
- Uma legenda curta para cada imagem ("fachada da loja", "café na xícara"). O Claude usa essa legenda para encaixar a imagem na cena certa.
- Autorização de uso de imagem das pessoas que aparecem.

### 3. Como o sistema escolhe as imagens

1. O Claude escreve o roteiro e, para cada cena, decide: usar uma imagem do usuário ou buscar no banco.
2. Para buscar, ele cria de 2 a 3 termos em inglês (os bancos têm mais resultados em inglês) com orientação, por exemplo `coffee beans close up` e orientação `landscape`.
3. O worker busca, baixa as 5 melhores opções e o Claude escolhe pela descrição e pelas cores que combinam com o perfil de estilo da referência.
4. Trechos de vídeo de banco entram como estão; fotos ganham movimento (zoom e deslocamento suave, o chamado efeito Ken Burns).
5. Se nada servir, a cena vira imagem gerada por IA ou um quadro de texto 2D.

### 4. Cuidados

- Guarde licença e crédito de cada arquivo (tabela `assets`).
- Não use pessoas de banco de imagens para representar clientes reais ou dar depoimentos.
- Evite marcas e logotipos de terceiros nas imagens de banco.
- Vídeos longos (perto de 18 min) precisam de muitas imagens: calcule uma troca a cada 3 a 6 segundos, ou seja, de 180 a 360 imagens e trechos. Por isso vale ter um banco pago ou muito material próprio.

## Uso do Claude no Painel

O Claude não oferece um número oficial de "tokens restantes do plano" para assinaturas Pro e Max. O que existe é o percentual usado da janela de 5 horas (a sessão) e da janela de 7 dias, com o horário em que cada uma reinicia. Por isso o Painel mostra tokens **usados** em número exato e o **restante** em percentual.

| Indicador no Painel | De onde vem | Atualização |
| --- | --- | --- |
| Tokens usados (hoje, na sessão, no mês) | Soma de `input_tokens`, `output_tokens` e cache que cada resposta do Agent SDK devolve, gravada em `claude_usage_events` | A cada chamada |
| Uso restante da sessão (5 h) | `100 − rate_limits.five_hour.used_percentage`, informação que o Claude Code passa ao script de status line ([referência](https://wmedia.es/en/tips/claude-code-usage-limit-status-line)) | A cada chamada do worker |
| Tempo até a sessão reiniciar | `rate_limits.five_hour.resets_at` menos a hora atual | Contagem regressiva no navegador a partir do valor salvo |
| Uso restante da semana | `100 − rate_limits.seven_day.used_percentage` e `seven_day.resets_at` | A cada chamada do worker |
| Tempo até o plano renovar | Data de renovação que o admin informa em `settings.plan_renews_at` (não há fonte automática) | Diária |
| Disponibilidade | Teste leve a cada 2 minutos + erros reais dos jobs | Contínua |

Caso o cliente use uma chave de API em vez de assinatura, troque as duas linhas de percentual pelos cabeçalhos `anthropic-ratelimit-tokens-remaining` e `anthropic-ratelimit-tokens-reset` de cada resposta ([referência](https://docs.aws.amazon.com/claude-platform/latest/userguide/rate-limits.md)), que medem o limite por minuto, e use o orçamento mensal definido pelo admin como "restante do plano".

**Avisos que o Painel deve mostrar**

| Situação | Como detectar | Aviso e ação |
| --- | --- | --- |
| Sessão perto do limite | Sessão com 80% ou mais usada | "Sessão do Claude em 85%. Reinicia às 14:20." Novos vídeos longos ficam na fila. |
| Limite atingido | Erro 429 / mensagem de limite | "Claude indisponível até 14:20 (limite da sessão)." Jobs pausam e voltam sozinhos no horário de reinício. |
| Limite semanal perto do fim | Semana com 90% ou mais usada | Aviso amarelo com a data de reinício; admin pode limitar vídeos por dia. |
| Serviço sobrecarregado | Erro 529 / overloaded | "Claude sobrecarregado. Nova tentativa em 1 min." Tentativas com espera crescente. |
| Sem login | Claude Code não autenticado na máquina | Aviso vermelho só para o admin: "Faça login no Claude Code neste computador." |
| Sem internet | Falha de rede no teste | "Sem conexão. Os vídeos voltam a ser criados quando a internet voltar." |

Observação: o campo `rate_limits` só aparece depois da primeira resposta de cada sessão e pode faltar em alguns tipos de conta. O sistema precisa tratar a ausência mostrando "sem dados ainda" em vez de zero.
