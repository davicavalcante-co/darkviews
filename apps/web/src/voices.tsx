import { useEffect, useRef, useState } from 'react'
import { api, csrf } from './api'
import { Modal, PageHead } from './ui'

type Voice = { id: string; name: string; kind: 'design' | 'clone'; status: 'draft' | 'published'; attrs: Record<string, string>; speed: number }
type Status = { online: boolean; attrs: Record<string, Record<string, string>>; sampleText: string }
const ATTR_LABEL: Record<string, string> = { gender: 'Gênero', age: 'Idade', pitch: 'Tom', style: 'Estilo', accent: 'Sotaque' }

// Áudio que exige login: busca com a sessão e toca.
async function play(path: string, body?: unknown) {
  const res = await fetch('/api' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() }, body: JSON.stringify(body) } : {})
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Não foi possível tocar a voz')
  const a = new Audio(URL.createObjectURL(await res.blob()))
  await a.play()
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
      <p className="muted">As vozes nascem como rascunho. Quando gostar, clique em <strong>Publicar</strong>: ela aparece na lista de vozes do Novo vídeo.</p>
      <h2>Publicadas</h2>
      <VoiceList list={published} empty="Nenhuma voz publicada ainda." onEdit={setEditing} reload={load} />
      <h2>Rascunhos</h2>
      <VoiceList list={drafts} empty="Nenhum rascunho. Clique em Nova voz para começar." onEdit={setEditing} reload={load} />
      {editing && status && <VoiceForm voice={editing === 'new' ? null : editing} status={status} onClose={() => { setEditing(null); load() }} />}
    </div>
  )
}

function VoiceList({ list, empty, onEdit, reload }: { list: Voice[]; empty: string; onEdit: (v: Voice) => void; reload: () => void }) {
  if (!list.length) return <p className="muted">{empty}</p>
  return <div className="cards">{list.map((v) => <VoiceCard key={v.id} v={v} onEdit={() => onEdit(v)} reload={reload} />)}</div>
}

function VoiceCard({ v, onEdit, reload }: { v: Voice; onEdit: () => void; reload: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label); setError('')
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const patch = (body: object) => act('Salvando…', async () => { await api(`/studio/voices/${v.id}`, { method: 'PATCH', body }); reload() })
  return (
    <article className="card voice-card">
      <header className="voice-head">
        <strong>{v.name}</strong>
        <span className="pill">{v.kind === 'clone' ? 'Clonada' : 'Criada'} · {v.status === 'published' ? 'Publicada' : 'Rascunho'}</span>
      </header>
      <div className="chips">
        <button type="button" className="ghost-btn" disabled={!!busy} onClick={() => act('Tocando…', () => play(`/studio/voices/${v.id}/sample`))}>Ouvir amostra</button>
        <button type="button" className="ghost-btn" disabled={!!busy} onClick={onEdit}>Editar</button>
      </div>
      <label className="field"><span className="field-label">Testar com um texto</span>
        <textarea rows={2} maxLength={300} value={text} placeholder="Escreva uma frase para ouvir esta voz" onChange={(e) => setText(e.target.value)} />
      </label>
      <button type="button" className="ghost-btn" disabled={!!busy || !text.trim()} onClick={() => act('Gerando…', () => play(`/studio/voices/${v.id}/preview`, { text }))}>{busy === 'Gerando…' ? 'Gerando…' : 'Ouvir este texto'}</button>
      <label className="field"><span className="field-label">Velocidade <span className="muted">{v.speed.toFixed(2)}×</span></span>
        <input type="range" min={0.7} max={1.3} step={0.05} defaultValue={v.speed} disabled={!!busy} onChange={(e) => patch({ speed: Number(e.target.value) })} />
      </label>
      {error && <p className="notice alert" role="alert">✕ {error}</p>}
      <footer className="chips">
        <button type="button" disabled={!!busy} onClick={() => patch({ published: v.status !== 'published' })}>{v.status === 'published' ? 'Voltar para rascunho' : 'Publicar'}</button>
        <button type="button" className="link" disabled={!!busy} onClick={() => setConfirm(true)}>Excluir</button>
      </footer>
      <Modal open={confirm} onClose={() => setConfirm(false)} title="Excluir esta voz?">
        <p>A voz "{v.name}" some da lista. Vídeos já prontos não mudam.</p>
        <footer className="modal-actions"><span className="spacer" />
          <button type="button" className="ghost-btn" onClick={() => setConfirm(false)}>Cancelar</button>
          <button type="button" onClick={() => act('Excluindo…', async () => { await api(`/studio/voices/${v.id}`, { method: 'DELETE' }); setConfirm(false); reload() })}>Excluir</button>
        </footer>
      </Modal>
    </article>
  )
}

// Criar (por características) ou clonar (gravando ou enviando um áudio). Ao editar, refaz a voz com o que mudou.
function VoiceForm({ voice, status, onClose }: { voice: Voice | null; status: Status; onClose: () => void }) {
  const [kind, setKind] = useState<'design' | 'clone'>(voice?.kind ?? 'design')
  const [name, setName] = useState(voice?.name ?? '')
  const [attrs, setAttrs] = useState<Record<string, string>>(voice?.attrs ?? { gender: 'female', age: 'young adult' })
  const [transcript, setTranscript] = useState('')
  const [audio, setAudio] = useState<Blob | null>(null)
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const rec = useRef<MediaRecorder | null>(null)

  async function toggleRecord() {
    if (recording) { rec.current?.stop(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const r = new MediaRecorder(stream), chunks: Blob[] = []
      r.ondataavailable = (e) => chunks.push(e.data)
      r.onstop = () => { stream.getTracks().forEach((t) => t.stop()); setAudio(new Blob(chunks, { type: r.mimeType })); setRecording(false) }
      r.start(); rec.current = r; setRecording(true)
    } catch { setError('Não consegui usar o microfone. Permita o microfone no navegador ou envie um arquivo.') }
  }

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
    <Modal open onClose={onClose} title={voice ? `Editar "${voice.name}"` : 'Nova voz'} kicker="Vozes">
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={kind === 'design'} onClick={() => setKind('design')}>Criar voz</button>
        <button type="button" role="tab" aria-selected={kind === 'clone'} onClick={() => setKind('clone')}>Clonar minha voz</button>
      </div>
      <label className="field"><span className="field-label">Nome da voz</span><input value={name} maxLength={60} placeholder="Ex.: Minha voz, Narradora calma" onChange={(e) => setName(e.target.value)} /></label>
      {kind === 'design' ? (
        <div className="grid">
          {Object.entries(status.attrs).map(([k, opts]) => (
            <label key={k} className="field"><span className="field-label">{ATTR_LABEL[k] ?? k}</span>
              <select value={attrs[k] ?? ''} onChange={(e) => setAttrs({ ...attrs, [k]: e.target.value })}>
                <option value="">Automático</option>
                {Object.entries(opts).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
          ))}
        </div>
      ) : (
        <>
          <p className="muted">Grave de 10 a 30 segundos falando naturalmente, num lugar sem barulho. Pode ler este texto: "{status.sampleText}"</p>
          <div className="chips">
            <button type="button" className={recording ? '' : 'ghost-btn'} onClick={toggleRecord}>{recording ? 'Parar gravação' : audio ? 'Gravar de novo' : 'Gravar minha voz'}</button>
            <label className="btn ghost">Enviar áudio
              <input type="file" hidden accept="audio/*,.mp3,.wav,.m4a" onChange={(e) => { setAudio(e.target.files?.[0] ?? null); e.target.value = '' }} />
            </label>
            {audio && !recording && <span className="pill">✓ Áudio pronto</span>}
          </div>
          <label className="field"><span className="field-label">O que você falou <span className="muted">opcional, deixa a cópia mais fiel</span></span>
            <textarea rows={2} maxLength={1000} value={transcript} onChange={(e) => setTranscript(e.target.value)} />
          </label>
        </>
      )}
      {error && <p className="notice alert" role="alert">✕ {error}</p>}
      <footer className="modal-actions"><span className="spacer" />
        <button type="button" className="ghost-btn" disabled={busy} onClick={onClose}>Cancelar</button>
        <button type="button" disabled={busy || recording || !name.trim() || (kind === 'clone' && !audio && voice?.kind !== 'clone')} onClick={save}>
          {busy ? 'Criando a voz… (a primeira do dia pode levar 5 minutos)' : voice ? 'Salvar' : 'Salvar como rascunho'}
        </button>
      </footer>
    </Modal>
  )
}
