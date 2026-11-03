#!/usr/bin/env bash
# Instala o OmniVoice Studio (servidor de voz local usado pela skill omnivoice). Baixa ~1,6 GB agora
# e ~2,4 GB do modelo na primeira narração. Idempotente: pode rodar de novo para atualizar.
set -euo pipefail
HOME_DIR="${OMNIVOICE_HOME:-$HOME/OmniVoice-Studio}"

if ! command -v uv >/dev/null; then
  echo "→ instalando uv (gerenciador de Python) via Homebrew"
  brew install uv
fi
if [ -d "$HOME_DIR/.git" ]; then
  echo "→ atualizando $HOME_DIR"; git -C "$HOME_DIR" pull --ff-only
else
  echo "→ baixando OmniVoice Studio em $HOME_DIR"; git clone --depth 1 https://github.com/debpalash/OmniVoice-Studio.git "$HOME_DIR"
fi
cd "$HOME_DIR"
echo "→ instalando dependências (pode levar alguns minutos)"
uv sync
VIRTUAL_ENV="$(pwd)/.venv" uv pip install 'mcp[cli]'
echo "✓ OmniVoice instalado. Ligue com: pnpm run omnivoice:start"
