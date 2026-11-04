#!/bin/zsh -l
# Dois cliques neste arquivo ligam o Corte Final e abrem o navegador. Para desligar, feche esta janela.
cd "$(dirname "$0")"
(sleep 6 && open http://localhost:5173) &
pnpm dev
