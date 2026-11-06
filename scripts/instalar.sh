#!/bin/zsh -l
# Instala o Darkviews num Mac novo, do zero. Pode rodar de novo quando quiser: o que já existe é pulado.
# Tudo fica dentro da pasta do projeto (programas de voz em vendor/ e .venv-*); só as ferramentas de sistema vêm do Homebrew.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ok()   { print -P "%F{green}✓%f $1"; }
step() { print -P "\n%F{cyan}→ $1%f"; }

step "1/8 Ferramentas da Apple (compilador)"
xcode-select -p >/dev/null 2>&1 || { xcode-select --install; echo "Termine a instalação que abriu na tela e rode este instalador de novo."; exit 1; }
ok "pronto"

step "2/8 Homebrew"
if ! command -v brew >/dev/null; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi
ok "pronto"

step "3/8 Programas do sistema (Node, FFmpeg com legendas, yt-dlp, Python, uv)"
for f in node pnpm ffmpeg-full yt-dlp python@3.11 uv whisper-cpp; do brew list --formula "$f" >/dev/null 2>&1 || brew install "$f"; done
command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code
ok "pronto"

step "4/8 Dependências do Darkviews"
pnpm install
ok "pronto"

step "5/8 Configuração e banco de dados"
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i '' "s/^MASTER_KEY=\"\"/MASTER_KEY=\"$(openssl rand -hex 32)\"/" .env
  ok "arquivo .env criado com chave nova"
fi
pnpm run db:push
pnpm run db:seed | tee /tmp/darkviews-seed.txt
ok "pronto"

step "6/8 Vozes locais (Kokoro e Piper)"
[ -x .venv-kokoro/bin/python ] || { uv venv -q --python 3.11 .venv-kokoro && uv pip install -q --python .venv-kokoro/bin/python kokoro soundfile; }
[ -x .venv-tts/bin/piper ] || { uv venv -q --python 3.11 .venv-tts && uv pip install -q --python .venv-tts/bin/python piper-tts; }
# Whisper: transcreve as referências e confere se cada fala da narração ficou clara.
[ -f vendor/whisper/ggml-small.bin ] || { mkdir -p vendor/whisper && curl -fL -o vendor/whisper/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin; }
grep -q '^WHISPER_MODEL=""' .env && sed -i '' "s|^WHISPER_MODEL=\"\"|WHISPER_MODEL=\"$ROOT/vendor/whisper/ggml-small.bin\"|" .env
ok "pronto (os modelos de voz baixam sozinhos na primeira fala)"

step "7/8 VoiceStudio (aba Vozes: criar e clonar vozes)"
bash scripts/voicestudio-setup.sh
ok "pronto (o modelo de voz, ~2,4 GB, baixa sozinho no primeiro uso)"

step "8/8 Login do Claude"
if claude auth status >/dev/null 2>&1; then ok "já está logado"
else echo "Vai abrir o login do Claude. Entre com a sua conta e volte para esta janela."; claude auth login || claude; fi

print -P "\n%F{green}Instalação concluída.%f"
grep -A1 -i "token de primeiro acesso" /tmp/darkviews-seed.txt || true
echo "Agora dê dois cliques em \"Ligar Darkviews\". No primeiro acesso, use a aba \"Primeiro acesso\" com o token acima."
