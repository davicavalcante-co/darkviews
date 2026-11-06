#!/usr/bin/env bash
# Instala o VoiceStudio (servidor de voz local da aba Vozes). Baixa ~1,6 GB agora
# e ~2,4 GB do modelo na primeira narração. Idempotente: pode rodar de novo para atualizar.
set -euo pipefail
HOME_DIR="${VOICESTUDIO_HOME:-$(cd "$(dirname "$0")/.." && pwd)/vendor/voicestudio}"

if ! command -v uv >/dev/null; then
  echo "→ instalando uv (gerenciador de Python) via Homebrew"
  brew install uv
fi
# Versão testada com o Darkviews (a API do VoiceStudio muda entre versões).
VERSION="5875fa91b8449c06998ad8394f3af4d6beb68cc9"
if [ ! -d "$HOME_DIR/.git" ]; then
  echo "→ baixando VoiceStudio em $HOME_DIR"; git clone -q https://github.com/debpalash/OmniVoice-Studio.git "$HOME_DIR"
fi
git -C "$HOME_DIR" fetch -q origin "$VERSION" 2>/dev/null || true
git -C "$HOME_DIR" checkout -q "$VERSION"
cd "$HOME_DIR"
echo "→ instalando dependências (pode levar alguns minutos)"
uv sync
echo "✓ VoiceStudio instalado. Ligue com: pnpm run voicestudio:start"
