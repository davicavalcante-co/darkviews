import type { ReactNode } from 'react'

// Conjunto único de ícones: grade de 24 px, traço de 1,75, pontas e cantos arredondados, cor do texto.
const PATHS: Record<string, ReactNode> = {
  painel: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  novo: <><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M12 8v8M8 12h8" /></>,
  projetos: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3 9h18M7 5v4M12 5v4M17 5v4" /></>,
  edicao: <><circle cx="6" cy="6" r="2.75" /><circle cx="6" cy="18" r="2.75" /><path d="M8.1 7.9 20 19.5M8.1 16.1 20 4.5" /></>,
  aprovacao: <><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  admin: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
  integracoes: <><path d="M9 7V4M15 7V4" /><path d="M6 7h12v4a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></>,
  sair: <><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><path d="m15 16 4-4-4-4M19 12H9" /></>,
  expandir: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 3v18M13.5 9.5 16 12l-2.5 2.5" /></>,
  recolher: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 3v18M16 9.5 13.5 12l2.5 2.5" /></>,
}

export function Icon({ name, size = 20 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}
