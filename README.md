# Darkviews

Darkviews cria vídeos para YouTube no seu próprio computador. Você descreve o vídeo, pode mandar um vídeo de referência e as suas fotos, e o sistema entrega o vídeo pronto: roteiro, imagens, narração, títulos de capítulo e efeitos. Depois você ajusta tudo num editor e gera os cortes verticais para Shorts, Reels, TikTok e Stories.

Tudo roda na sua máquina, em `http://localhost:5173`. O roteiro e as escolhas de imagem são feitos pelo Claude, com a sua conta.

## O que ele faz

- **Novo vídeo:** prompt, duração, link ou vídeo de referência, suas fotos (com uma legenda curta para cada uma), voz e estilo de edição.
- **Criação automática:** analisa a referência, escreve o roteiro, busca imagens nos bancos gratuitos (ou usa só as suas), narra e monta o vídeo em 1920×1080.
- **Aprovação das imagens** antes da narração: você recusa as que não gostar e o sistema busca outras. Cada rodada tem 10 minutos; sem resposta, as imagens são aprovadas sozinhas.
- **Narração com uma voz só:** a voz escolhida narra o vídeo inteiro (nunca troca por outra) e cada fala é conferida pelo Whisper; se sair pouco clara, é gerada de novo.
- **Editor em camadas** (parecido com um programa de edição):
  - prévia do vídeo e linha do tempo com quadros, cenas, enunciados, legenda, narração, trilha e efeitos;
  - **Cena:** movimento da foto (Ken Burns, parallax, recorte, zoom rápido), curva do movimento e transição;
  - **Áudio:** ouvir a narração de cada cena, escolher a trilha sonora e o volume, e o volume dos efeitos;
  - **Legenda:** estilos prontos, edição linha por linha como uma transcrição, destaque de palavras e alinhamento;
  - **Enunciados:** os títulos de cada etapa, com estilo próprio que vale para todos;
  - tudo fica em rascunho até você clicar em **Salvar** e **Renderizar vídeo**.
- **Edição por contexto:** assiste, pausa e escreve o que mudar naquele momento. No fim, o Claude refaz o vídeo com todos os pedidos.
- **Versões:** o que foi pedido de uma versão para a outra.
- **Publicação:** título, descrição, palavras-chave e thumbnail numa tela só.
- **Aprovar:** escolhe o trecho e o enquadramento e gera os cortes 9:16.
- **Dark Vídeos** (aba em teste): envie vídeos longos; o sistema monta a imagem com cortes aleatórios deles (só transição) e depois coloca a narração e a legenda. Aceita ideia do Brainstorm e estilo de vídeo analisado. Vídeos de até 60 minutos.
- **Vozes:** crie uma voz por características ou **clone a sua própria voz** (gravando ou enviando um áudio). Depois de publicada, ela aparece como opção no Novo vídeo.
- **Integrações:** bancos de imagem, vozes e músicas, gratuitos ou com a sua chave.
- **Admin:** usuários, fontes, auditoria e logs.

## Instalar num Mac (passo a passo)

Precisa de: Mac com chip Apple (M1 ou mais novo), internet, uns **15 GB livres** e uma conta do Claude (Pro ou Max). A primeira instalação leva de 20 a 40 minutos.

1. Baixe o projeto: no GitHub, botão verde **Code → Download ZIP**, e descompacte. Ou, no terminal:
   ```bash
   git clone https://github.com/davicavalcante-co/darkviews.git
   ```
2. Dê **dois cliques** em `Instalar Darkviews`.
   - Se o Mac avisar que é de fonte desconhecida: botão direito → **Abrir** → **Abrir**.
   - Se pedir a senha do Mac, digite (é o Homebrew instalando os programas).
   - Se abrir uma janela da Apple pedindo para instalar ferramentas, aceite e, quando terminar, dê dois cliques no instalador de novo.
3. No fim, abre o **login do Claude**: entre com a sua conta.
4. Anote o **token de primeiro acesso** que aparece no final.

O instalador pode ser rodado de novo quando quiser: o que já está instalado é pulado.

## Usar no dia a dia

1. Dê **dois cliques** em `Ligar Darkviews`. O navegador abre sozinho em `http://localhost:5173`.
2. **Só na primeira vez:** na tela de login, aba **Primeiro acesso**, cole o token e clique em **Entrar com o token**. Dentro do sistema abre uma janela para você definir o seu nome, e-mail e senha. Daí em diante, entre normalmente com eles. O sistema começa vazio, só com a sua conta.
3. Para desligar, feche a janela do terminal que abriu.

Para usar vozes próprias (aba **Vozes**): clique em **Ligar VoiceStudio** e, na primeira vez, em **Aceitar licença do modelo**. A primeira voz do dia demora uns 5 minutos para carregar.

## Se algo der errado

| O que aparece | O que fazer |
| --- | --- |
| "Faça login no Claude Code" | Abra o terminal, rode `claude` e use `/login`. Os vídeos pausados continuam sozinhos. |
| Limite do Claude atingido | O vídeo pausa e continua sozinho no horário em que o limite renova. |
| "O VoiceStudio está desligado" | Aba **Vozes → Ligar VoiceStudio**. |
| Narração com voz própria lenta | É normal: cada cena leva de 10 a 25 s. O andamento mostra "cena X de Y" e o tempo que falta. Feche outros programas se o Mac estiver com pouca memória. |
| "A voz escolhida está desligada" | Ligue a voz de novo em **Integrações** ou escolha outra no editor. O vídeo nunca troca de voz sozinho. |
| Vídeo parou com erro | Abra o projeto e clique em **Tentar de novo**: só a etapa que falhou é refeita. |
| A porta 3333 ou 5173 está em uso | Já tem um Darkviews ligado. Feche a outra janela do terminal e ligue de novo. |

## O que fica onde

| Pasta | O que é |
| --- | --- |
| `data/app.db` | Banco de dados (projetos, usuários, versões). |
| `storage/` | Arquivos: envios, imagens, narrações, vídeos e cortes. |
| `.env` | Configuração e a chave que protege as senhas das integrações. **Não compartilhe.** |
| `vendor/voicestudio/` | VoiceStudio, usado na aba Vozes. |

**Backup:** copie `data/app.db` e a pasta `storage/` com o sistema desligado. Guarde o `.env` **separado**: sem ele as chaves das integrações não podem ser lidas.

## Licenças

O Darkviews conversa com o VoiceStudio (AGPL-3.0) pela rede local, sem incluir o código dele. O modelo de voz padrão do VoiceStudio é **não comercial** (CC-BY-NC): uso pessoal.

## Para quem desenvolve

- Peças: `apps/web` (site, React), `apps/api` (servidor, Fastify), `apps/worker` (cria os vídeos com FFmpeg), `apps/mcp` (conversa com o Claude), `packages/*` (banco, tipos e integrações).
- Ligar pelo terminal: `pnpm dev`. Testes: `pnpm test`.
