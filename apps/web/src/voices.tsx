import { useEffect, useRef, useState } from 'react'
import { api, csrf } from './api'
import { Modal, PageHead } from './ui'

type Voice = { id: string; name: string; kind: 'design' | 'clone'; status: 'draft' | 'published'; attrs: Record<string, string>; speed: number }
type Status = { online: boolean; licensed: boolean; attrs: Record<string, Record<string, string>>; sampleText: string }
const ATTR_LABEL: Record<string, string> = { gender: 'Gênero', age: 'Idade', pitch: 'Tom', style: 'Estilo', accent: 'Sotaque' }

// Áudio que exige login: busca com a sessão e toca. Um por vez; devolve o player para dar pausa.
let current: HTMLAudioElement | null = null
async function play(path: string, body?: unknown) {
  const res = await fetch('/api' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() }, body: JSON.stringify(body) } : {})
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Não foi possível tocar a voz')
  current?.pause()
  current = new Audio(URL.createObjectURL(await res.blob()))
  await current.play()
  return current
}

// Botão tocar/pausar: mostra o estado e para no fim do áudio.
function PlayButton({ path, body, label, disabled }: { path: string; body?: unknown; label: string; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const [error, setError] = useState('')
  const audio = useRef<HTMLAudioElement | null>(null)
  useEffect(() => () => audio.current?.pause(), [])
  async function toggle() {
    if (state === 'playing') { audio.current?.pause(); setState('idle'); return }
    setState('loading'); setError('')
    try {
      const a = await play(path, body); audio.current = a; setState('playing')
      a.onended = a.onpause = () => setState('idle')
    } catch (e) { setError((e as Error).message); setState('idle') }
  }
  return (
    <>
      <button type="button" className="ghost-btn play-btn" disabled={disabled || state === 'loading'} onClick={toggle} aria-pressed={state === 'playing'}>
        {state === 'playing' ? '❚❚ Pausar' : state === 'loading' ? 'Carregando…' : `▶ ${label}`}
      </button>
      {error && <p className="notice alert" role="alert">✕ {error}</p>}
    </>
  )
}

// Aba Vozes: criar uma voz por características, clonar a própria voz, testar, ajustar e publicar para usar nos vídeos.
export function VoicesPage() {
  const [status, setStatus] = useState<Status | null>(null)
  const [voices, setVoices] = useState<Voice[]>([])
  const [editing, setEditing] = useState<Voice | 'new' | null>(null)
  const load = () => api<Voice[]>('/studio/voices').then(setVoices).catch(() => {})
  useEffect(() => { api<Status>('/studio/status').then(setStatus).catch(() => {}); load() }, [])
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')
  async function start() {
    setStarting(true); setStartError('')
    try { await api('/studio/start', { method: 'POST' }); setStatus(await api<Status>('/studio/status')) }
    catch (e) { setStartError((e as Error).message) } finally { setStarting(false) }
  }
  async function accept() {
    setStarting(true); setStartError('')
    try { setStatus({ ...status!, ...(await api<Pick<Status, 'online' | 'licensed'>>('/studio/accept-license', { method: 'POST' })) }) }
    catch (e) { setStartError((e as Error).message) } finally { setStarting(false) }
  }
  const drafts = voices.filter((v) => v.status === 'draft'), published = voices.filter((v) => v.status === 'published')

  return (
    <div className="page">
      <PageHead kicker="Crie, clone e edite" title="Vozes">
        <button type="button" onClick={() => setEditing('new')}>Nova voz</button>
      </PageHead>
      {status && !status.online && (
        <div className="notice alert" role="status">
          <p>O VoiceStudio está desligado. Ele é quem cria e fala as vozes.</p>
          <button type="button" disabled={starting} onClick={start}>{starting ? 'Ligando… (até 2 minutos)' : 'Ligar VoiceStudio'}</button>
          {startError && <p>✕ {startError}</p>}
        </div>
      )}
      {status?.online && !status.licensed && (
        <div className="notice alert" role="status">
          <p>Falta um passo único: aceitar a licença do modelo de voz (uso pessoal, não comercial).</p>
          <button type="button" disabled={starting} onClick={accept}>{starting ? 'Aceitando…' : 'Aceitar licença do modelo'}</button>
          {startError && <p>✕ {startError}</p>}
        </div>
      )}
      <ol className="voice-steps">
        <li><b>1</b> Crie ou clone uma voz</li>
        <li><b>2</b> Ouça e ajuste a velocidade</li>
        <li><b>3</b> Publique: ela aparece no Novo vídeo</li>
      </ol>
      {!voices.length && (
        <button type="button" className="voice-empty" onClick={() => setEditing('new')}>
          <span className="kind-icon">🎙️</span><b>Crie a sua primeira voz</b><small>Clone a sua voz em 30 segundos ou invente uma nova.</small>
        </button>
      )}
      {published.length > 0 && <><h2 className="voice-h">Publicadas <span className="muted">{published.length}</span></h2><VoiceList list={published} onEdit={setEditing} reload={load} /></>}
      {drafts.length > 0 && <><h2 className="voice-h">Rascunhos <span className="muted">{drafts.length}</span></h2><VoiceList list={drafts} onEdit={setEditing} reload={load} /></>}
      {editing && status && <VoiceForm voice={editing === 'new' ? null : editing} status={status} onClose={() => { setEditing(null); load() }} />}
    </div>
  )
}

function VoiceList({ list, onEdit, reload }: { list: Voice[]; onEdit: (v: Voice) => void; reload: () => void }) {
  return <div className="voice-grid">{list.map((v) => <VoiceCard key={v.id} v={v} onEdit={() => onEdit(v)} reload={reload} />)}</div>
}

function VoiceCard({ v, onEdit, reload }: { v: Voice; onEdit: () => void; reload: () => void }) {
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(false)
    addEventListener('click', close)
    return () => removeEventListener('click', close)
  }, [menu])
  return (
    <article className={`voice-card ${v.status}`}>
      <header className="voice-head">
        <span className="voice-avatar" aria-hidden="true">{v.name.slice(0, 1).toUpperCase()}</span>
        <div><strong>{v.name}</strong><small className="muted">{v.kind === 'clone' ? 'Voz clonada' : 'Voz criada'} · {v.status === 'published' ? 'publicada' : 'rascunho'}</small></div>
        <div className="menu-wrap">
          <button type="button" className="icon-btn" aria-label="Mais opções" aria-expanded={menu} onClick={(e) => { e.stopPropagation(); setMenu(!menu) }}>⋯</button>
          {menu && (
            <div className="menu" role="menu">
              <button type="button" role="menuitem" onClick={onEdit}>Editar</button>
              <button type="button" role="menuitem" className="danger-item" onClick={() => setConfirm(true)}>Excluir</button>
            </div>
          )}
        </div>
      </header>
      <PlayButton path={`/studio/voices/${v.id}/sample`} label="Ouvir a voz" />
      {error && <p className="notice alert" role="alert">✕ {error}</p>}
      <Modal open={confirm} onClose={() => setConfirm(false)} title="Excluir esta voz?">
        <p>A voz "{v.name}" some da lista. Vídeos já prontos não mudam.</p>
        <footer className="modal-actions"><span className="spacer" />
          <button type="button" className="ghost-btn" onClick={() => setConfirm(false)}>Cancelar</button>
          <button type="button" onClick={async () => { try { await api(`/studio/voices/${v.id}`, { method: 'DELETE' }); setConfirm(false); reload() } catch (e) { setError((e as Error).message) } }}>Excluir</button>
        </footer>
      </Modal>
    </article>
  )
}

// Dentro do pop-up de edição: testar com um texto, velocidade e publicar ou voltar para rascunho (salvam na hora).
function VoiceTune({ voice }: { voice: Voice }) {
  const [text, setText] = useState('')
  const [speed, setSpeed] = useState(voice.speed)
  const [status, setStatus] = useState(voice.status)
  const [error, setError] = useState('')
  const patch = (body: object) => api(`/studio/voices/${voice.id}`, { method: 'PATCH', body }).catch((e) => setError((e as Error).message))
  return (
    <section className="tune">
      <span className="field-label">Testar e ajustar</span>
      <div className="try-row">
        <input maxLength={300} value={text} placeholder="Digite uma frase para ouvir esta voz…" onChange={(e) => setText(e.target.value)} />
        <PlayButton path={`/studio/voices/${voice.id}/preview`} body={{ text }} label="Ouvir" disabled={!text.trim()} />
      </div>
      <label className="range-row">Velocidade
        <input type="range" min={0.7} max={1.3} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} onPointerUp={() => patch({ speed })} />
        <b>{speed.toFixed(2)}×</b>
      </label>
      <label className="switch-row">
        <input type="checkbox" checked={status === 'published'} onChange={(e) => { const on = e.target.checked; setStatus(on ? 'published' : 'draft'); patch({ published: on }) }} />
        <span>{status === 'published' ? 'Publicada: aparece no Novo vídeo' : 'Rascunho: ainda não aparece no Novo vídeo'}</span>
      </label>
      {error && <p className="notice alert" role="alert">✕ {error}</p>}
    </section>
  )
}

// Frase para ler na gravação: ~20 s em ritmo natural, com sons variados do português (dá uma cópia mais fiel).
const READ_TEXT = 'Olá! Esta é a minha voz. Hoje eu vou contar uma história curiosa, com calma e clareza. Cada vídeo começa com uma boa ideia, um pouco de café e muita vontade de explicar as coisas de um jeito simples.'
const MIN_S = 10, MAX_S = 30
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

// Gravador: tempo na tela, medidor de volume, para sozinho em 30 s e deixa ouvir antes de salvar.
function Recorder({ audio, onAudio, onError }: { audio: Blob | null; onAudio: (b: Blob | null, seconds: number) => void; onError: (m: string) => void }) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const [length, setLength] = useState(0)
  const rec = useRef<MediaRecorder | null>(null)
  const url = audio ? URL.createObjectURL(audio) : null
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  useEffect(() => () => rec.current?.stop(), [])

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      const r = new MediaRecorder(stream), chunks: Blob[] = []
      const ctx = new AudioContext(), an = ctx.createAnalyser(); an.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(an)
      const buf = new Uint8Array(an.fftSize), t0 = performance.now()
      let raf = 0
      const tick = () => {
        an.getByteTimeDomainData(buf)
        setLevel(Math.min(1, Math.max(...buf.map((v) => Math.abs(v - 128))) / 64))
        const el = (performance.now() - t0) / 1000
        setSeconds(el)
        if (el >= MAX_S) r.stop(); else raf = requestAnimationFrame(tick)
      }
      r.ondataavailable = (e) => chunks.push(e.data)
      r.onstop = () => {
        cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); ctx.close()
        const el = Math.min(MAX_S, (performance.now() - t0) / 1000)
        setRecording(false); setLevel(0); setLength(el)
        onAudio(new Blob(chunks, { type: r.mimeType }), el)
      }
      r.start(); rec.current = r; setRecording(true); setSeconds(0); onAudio(null, 0)
      raf = requestAnimationFrame(tick)
    } catch { onError('Não consegui usar o microfone. Permita o microfone no navegador ou envie um arquivo.') }
  }

  const shown = recording ? seconds : length
  return (
    <div className={`recorder${recording ? ' live' : ''}`}>
      <div className="read-card">
        <span className="read-tag">{recording ? 'Leia em voz alta' : 'Frase para ler na gravação'}</span>
        <p>{READ_TEXT}</p>
      </div>
      <div className="rec-row">
        <button type="button" className={`rec-btn${recording ? ' on' : ''}`} onClick={() => (recording ? rec.current?.stop() : start())} aria-label={recording ? 'Parar gravação' : 'Gravar'}>
          <span />
        </button>
        <div className="rec-meta">
          <div className="rec-time"><b>{clock(shown)}</b><span className="muted"> / {clock(MAX_S)}</span>
            <span className={`rec-hint ${shown >= MIN_S ? 'ok' : ''}`}>{recording ? (seconds < MIN_S ? `fale mais ${Math.ceil(MIN_S - seconds)} s` : 'ótimo, pode parar quando terminar') : audio ? (length && length < MIN_S ? 'curto demais: grave pelo menos 10 s' : 'gravação pronta') : 'mínimo 10 s · para sozinho em 30 s'}</span>
          </div>
          <div className="rec-bar" aria-hidden="true">
            <span className="rec-fill" style={{ width: `${(shown / MAX_S) * 100}%` }} />
            <span className="rec-min" style={{ left: `${(MIN_S / MAX_S) * 100}%` }} />
          </div>
          <div className="rec-level" aria-hidden="true">{Array.from({ length: 24 }, (_, i) => <i key={i} className={recording && i / 24 < level ? 'on' : ''} />)}</div>
        </div>
      </div>
      {audio && !recording && (
        <div className="rec-done">
          {url && <audio controls src={url} onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d)) { setLength(d); onAudio(audio, d) } }} />}
          <button type="button" className="link" onClick={start}>Gravar de novo</button>
        </div>
      )}
      <label className="link upload-link">ou envie um arquivo de áudio (MP3, WAV, M4A)
        <input type="file" hidden accept="audio/*,.mp3,.wav,.m4a" onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ''; setLength(0); onAudio(f, 0) }} />
      </label>
    </div>
  )
}

// Criar (por características) ou clonar (gravando ou enviando um áudio). Ao editar, refaz a voz com o que mudou.
function VoiceForm({ voice, status, onClose }: { voice: Voice | null; status: Status; onClose: () => void }) {
  const [kind, setKind] = useState<'design' | 'clone'>(voice?.kind ?? 'design')
  const [name, setName] = useState(voice?.name ?? '')
  const [attrs, setAttrs] = useState<Record<string, string>>(voice?.attrs ?? { gender: 'female', age: 'young adult' })
  const [transcript, setTranscript] = useState('')
  const [audio, setAudio] = useState<Blob | null>(null)
  const [seconds, setSeconds] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Gravou lendo a frase: ela vira a transcrição (deixa a cópia mais fiel). Arquivo enviado: a pessoa escreve, se quiser.
  const onAudio = (b: Blob | null, s: number) => {
    setAudio(b); setSeconds(s); if (b) setError('')
    if (b && !(b instanceof File)) setTranscript(READ_TEXT)
    if (b instanceof File) setTranscript('')
  }
  const tooShort = kind === 'clone' && audio && seconds > 0 && seconds < MIN_S

  async function save() {
    // Só nome mudou: renomeia sem refazer a voz.
    const onlyName = voice && kind === voice.kind && (kind === 'clone' ? !audio : JSON.stringify(attrs) === JSON.stringify(voice.attrs))
    setBusy(true); setError('')
    try {
      if (onlyName) await api(`/studio/voices/${voice!.id}`, { method: 'PATCH', body: { name } })
      else {
        const body = new FormData()
        body.append('name', name); body.append('kind', kind); body.append('transcript', transcript)
        if (kind === 'design') for (const [k, v] of Object.entries(attrs)) if (v) body.append(k, v)
        if (kind === 'clone' && audio) body.append('audio', audio, 'voz')
        await api(voice ? `/studio/voices/${voice.id}` : '/studio/voices', { method: voice ? 'PUT' : 'POST', body })
      }
      onClose()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Modal open onClose={onClose} title={voice ? `Editar "${voice.name}"` : 'Nova voz'} kicker="Vozes" wide>
      <div className="voice-form">
        <label className="field"><span className="field-label">Nome da voz</span><input value={name} maxLength={60} placeholder="Ex.: Minha voz, Narradora calma" onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <div className="kind-cards" role="radiogroup" aria-label="Como criar a voz">
          <button type="button" role="radio" aria-checked={kind === 'clone'} className="kind-card" onClick={() => setKind('clone')}>
            <span className="kind-icon">🎙️</span><b>Clonar minha voz</b><small>Grave 10 a 30 s lendo a frase. A voz fica igual à sua.</small>
          </button>
          <button type="button" role="radio" aria-checked={kind === 'design'} className="kind-card" onClick={() => setKind('design')}>
            <span className="kind-icon">✨</span><b>Criar uma voz</b><small>Escolha gênero, idade e tom. O sistema inventa a voz.</small>
          </button>
        </div>

        {kind === 'design' ? (
          <div className="attr-grid">
            {Object.entries(status.attrs).map(([k, opts]) => (
              <div key={k} className="field"><span className="field-label">{ATTR_LABEL[k] ?? k}</span>
                <div className="choice-row">
                  <button type="button" className="choice small-choice" aria-pressed={!attrs[k]} onClick={() => setAttrs({ ...attrs, [k]: '' })}>Auto</button>
                  {Object.entries(opts).map(([id, l]) => <button key={id} type="button" className="choice small-choice" aria-pressed={attrs[k] === id} onClick={() => setAttrs({ ...attrs, [k]: id })}>{l}</button>)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            <Recorder audio={audio} onAudio={onAudio} onError={setError} />
            {audio && (
              <label className="field"><span className="field-label">O que foi falado <span className="muted">deixa a cópia mais fiel</span></span>
                <textarea rows={2} maxLength={1000} value={transcript} placeholder="Escreva o que você falou no áudio (opcional)" onChange={(e) => setTranscript(e.target.value)} />
              </label>
            )}
          </>
        )}
        {voice && <VoiceTune voice={voice} />}
        {error && <p className="notice alert" role="alert">✕ {error}</p>}
      </div>
      <footer className="modal-actions"><span className="spacer" />
        <button type="button" className="ghost-btn" disabled={busy} onClick={onClose}>Cancelar</button>
        <button type="button" disabled={busy || !name.trim() || !!tooShort || (kind === 'clone' && !audio && voice?.kind !== 'clone')} onClick={save}>
          {busy ? 'Criando a voz… (a primeira do dia pode levar 5 minutos)' : voice ? 'Salvar' : 'Criar voz'}
        </button>
      </footer>
    </Modal>
  )
}
