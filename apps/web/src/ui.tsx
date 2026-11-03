import { useEffect, useRef, type ReactNode } from 'react'

// Cabeçalho de página: rótulo pequeno, título grande e ações à direita, com régua grossa embaixo.
export function PageHead({ kicker, title, children, back }: { kicker?: string; title: ReactNode; children?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <header className="page-head">
      <div>
        {back && <a className="back" href={back.href}>← {back.label}</a>}
        {kicker && <span className="kicker">{kicker}</span>}
        <h1>{title}</h1>
      </div>
      {children && <div className="actions">{children}</div>}
    </header>
  )
}

// Seção numerada da grade (01, 02...): régua fina, índice e título em caixa alta.
export function Section({ idx, title, aside, children }: { idx: number; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head"><span className="idx">{String(idx).padStart(2, '0')}</span><h2>{title}</h2>{aside && <div className="aside">{aside}</div>}</div>
      {children}
    </section>
  )
}

// Popup com o <dialog> nativo: foco, tecla Esc e fundo escurecido já vêm do navegador.
export function Modal({ open, onClose, title, kicker, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; kicker?: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} className={`modal${wide ? ' wide' : ''}`} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose() }}>
      {open && (
        <div className="modal-body">
          <header className="modal-head">
            <div>{kicker && <span className="kicker">{kicker}</span>}<h2>{title}</h2></div>
            <button type="button" className="icon-btn close" onClick={onClose} aria-label="Fechar">✕</button>
          </header>
          {children}
        </div>
      )}
    </dialog>
  )
}

// Passo a passo numerado e grande, para ler sem esforço.
export function Steps({ steps }: { steps: ReactNode[] }) {
  return <ol className="steps">{steps.map((s, i) => <li key={i}><span className="step-n">{i + 1}</span><div>{s}</div></li>)}</ol>
}
