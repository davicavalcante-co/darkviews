# Narração com Kokoro (voz neural local, modelo Apache-2.0). Lê uma lista JSON pela entrada padrão:
# [{"text": "...", "out": "/caminho.wav", "voice": "pf_dora", "speed": 1.0}, ...] e grava um WAV (24 kHz) por item.
# Carrega o modelo uma vez só para todas as falas do vídeo.
import json, sys
import numpy as np
import soundfile as sf
from kokoro import KPipeline

items = json.load(sys.stdin)
pipeline = KPipeline(lang_code='p')  # português do Brasil
for it in items:
    chunks = [audio for _, _, audio in pipeline(it['text'], voice=it.get('voice', 'pf_dora'), speed=float(it.get('speed', 1.0)))]
    sf.write(it['out'], np.concatenate(chunks) if chunks else np.zeros(2400), 24000)
    print(it['out'], flush=True)
