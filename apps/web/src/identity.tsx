import { useEffect, useState } from 'react'
import { DEFAULT_IDENTITY, type Identity } from '@corte/shared'
import { api, useFonts } from './api'
import { AlignIcons } from './edit'
import { FontSelect, loadFontPreview } from './ui'

// Admin → Identidade: o visual padrão dos vídeos novos (legenda, cartela, faixa e fundo). Cada vídeo ainda pode mudar no editor.
export function IdentityTab() {
  const fonts = useFonts()
  const [id, setId] = useState<Identity | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api<{ identity: Identity }>('/me/identity').then((r) => setId(r.identity)) }, [])
  useEffect(() => { if (id) { loadFontPreview(id.caption.fontFamily); loadFontPreview(id.title.fontFamily) } }, [id?.caption.fontFamily, id?.title.fontFamily])
  if (!id) return null
  const cap = (p: Partial<Identity['caption']>) => { setId({ ...id, caption: { ...id.caption, ...p } }); setMsg('') }
  const tit = (p: Partial<Identity['title']>) => { setId({ ...id, title: { ...id.title, ...p } }); setMsg('') }
  const up = (t: string) => (id.title.upper ? t.toUpperCase() : t)
  async function save(next: Identity, text: string) {
    setBusy(true)
    try { setId((await api<{ identity: Identity }>('/me/identity', { method: 'PUT', body: next })).identity); setMsg(text) }
    catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }
  const [cv, ch] = id.caption.position.split('-')
  return (
    <div className="identity">
      <div className="identity-preview">
        <div className="id-screen" style={{ background: id.bgColor }}>
          <span className={`id-card ${id.title.cardAlign.replace('-', ' ')}`} style={{ fontFamily: id.title.fontFamily, color: id.title.color, fontSize: `${(id.title.size / 1920) * 100}cqw` }}>{up('Capítulo 1')}</span>
        </div>
        <div className="id-screen photo">
          <span className={`id-band ${id.title.bandAlign.replace('-', ' ')}`} style={{ fontFamily: id.title.fontFamily, background: id.title.bandColor, fontSize: `${(id.title.bandSize / 1920) * 100}cqw` }}>{up('Destaque')}</span>
          <span className={`id-cap ${cv} ${ch}${id.caption.outline ? ' outlined' : ''}`} style={{ fontFamily: id.caption.fontFamily, fontWeight: id.caption.fontWeight, color: id.caption.color, fontSize: `${(id.caption.size / 1920) * 100}cqw` }}>
            Aqui o <span style={{ color: id.caption.highlightColor }}>vídeo</span> começa
          </span>
        </div>
        <small className="muted">Prévia: cartela de capítulo (no fundo) e cena com faixa de destaque e legenda.</small>
      </div>

      <div className="identity-form">
        <section className="panel">
          <span className="panel-title">Fundo</span>
          <label className="range-row">Cor do fundo das cartelas<input type="color" value={id.bgColor} onChange={(e) => { setId({ ...id, bgColor: e.target.value.toUpperCase() }); setMsg('') }} /></label>
        </section>
        <section className="panel">
          <span className="panel-title">Legenda</span>
          <div className="profile-grid">
            <div className="span2"><FontSelect value={id.caption.fontFamily} fonts={fonts} onChange={(fontFamily) => cap({ fontFamily })} /></div>
            <label>Peso<select value={id.caption.fontWeight} onChange={(e) => cap({ fontWeight: Number(e.target.value) as 400 | 700 | 900 })}><option value={400}>Normal</option><option value={700}>Negrito</option><option value={900}>Extra</option></select></label>
            <label>Tamanho<input type="number" min={24} max={140} value={id.caption.size} onChange={(e) => cap({ size: Number(e.target.value) })} /></label>
            <label>Cor<input type="color" value={id.caption.color} onChange={(e) => cap({ color: e.target.value.toUpperCase() })} /></label>
            <label>Cor do destaque<input type="color" value={id.caption.highlightColor} onChange={(e) => cap({ highlightColor: e.target.value.toUpperCase() })} /></label>
            <label>Destaque<select value={id.caption.highlightMode} onChange={(e) => cap({ highlightMode: e.target.value as Identity['caption']['highlightMode'] })}><option value="palavra-chave">Palavras-chave</option><option value="karaokê">Karaokê</option><option value="manual">Manual</option></select></label>
            <label className="check"><input type="checkbox" checked={id.caption.outline} onChange={(e) => cap({ outline: e.target.checked })} /> Traçado nas letras</label>
            <div className="span2"><span className="field-label">Posição</span><AlignIcons value={id.caption.position} onChange={(position) => cap({ position })} /></div>
          </div>
        </section>
        <section className="panel">
          <span className="panel-title">Cartela e enunciados</span>
          <div className="profile-grid">
            <div className="span2"><FontSelect value={id.title.fontFamily} fonts={fonts} onChange={(fontFamily) => tit({ fontFamily })} /></div>
            <label>Tamanho da cartela<input type="number" min={60} max={260} value={id.title.size} onChange={(e) => tit({ size: Number(e.target.value) })} /></label>
            <label>Tamanho da faixa<input type="number" min={24} max={140} value={id.title.bandSize} onChange={(e) => tit({ bandSize: Number(e.target.value) })} /></label>
            <label>Cor do texto<input type="color" value={id.title.color} onChange={(e) => tit({ color: e.target.value.toUpperCase() })} /></label>
            <label>Cor da faixa<input type="color" value={id.title.bandColor} onChange={(e) => tit({ bandColor: e.target.value.toUpperCase() })} /></label>
            <div><span className="field-label">Cartela</span><AlignIcons value={id.title.cardAlign} onChange={(cardAlign) => tit({ cardAlign })} /></div>
            <div><span className="field-label">Faixa</span><AlignIcons value={id.title.bandAlign} onChange={(bandAlign) => tit({ bandAlign })} /></div>
            <label className="check span2"><input type="checkbox" checked={id.title.upper} onChange={(e) => tit({ upper: e.target.checked })} /> Tudo em maiúsculas</label>
          </div>
        </section>
        <div className="row wrap">
          {msg && <span className="ok">{msg}</span>}
          <span className="spacer" />
          <button type="button" className="link" disabled={busy} onClick={() => save(DEFAULT_IDENTITY, 'Voltou para a identidade padrão do sistema.')}>Voltar ao padrão do sistema</button>
          <button type="button" disabled={busy} onClick={() => save(id, 'Identidade salva. Vale para os próximos vídeos.')}>{busy ? 'Salvando…' : 'Salvar identidade'}</button>
        </div>
      </div>
    </div>
  )
}
