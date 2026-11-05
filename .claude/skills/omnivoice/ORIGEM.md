# Origem desta skill

Copiada de [broomva/skills](https://github.com/broomva/skills/tree/main/skills/audio/omnivoice) (commit `eeaeee6`, 2026-11-01), licença MIT (arquivo `LICENSE` nesta pasta).

No Darkviews ela é usada pelo worker: na etapa "Gerando áudio", o Claude Code carrega esta skill e usa as ferramentas MCP do OmniVoice (`design_voice`, `generate_speech`) para criar a voz que o cliente pediu e narrar cada cena. Os áudios são gravados em arquivo (`OMNIVOICE_MCP_OUTPUT_MODE=files`), então o áudio não passa pelo contexto do Claude.

Licenças de terceiros: OmniVoice Studio (`debpalash/OmniVoice-Studio`) é AGPL-3.0 e roda como programa separado, acessado por HTTP/MCP. O repositório `k2-fsa/OmniVoice` é Apache-2.0 (código), mas **os pesos do modelo de voz são não comerciais** (o próprio OmniVoice informa: "CC-BY-NC; Higgs Audio 2; Meta Llama 3", categoria noncommercial) e a geração fica bloqueada (HTTP 403 `model_licence_required`) até a licença ser aceita no Model Catalogue. O trecho do SKILL.md que cita FSL está desatualizado.

## Alterações locais

- `scripts/start-backend.sh`: `|| true` na busca de quem ocupa a porta 3900. Com `set -euo pipefail`, o `lsof` sem resultado (porta livre, o caso normal) saía com 1 e encerrava o script sem mensagem.
