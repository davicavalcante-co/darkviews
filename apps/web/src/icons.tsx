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
  vozes: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  legendas: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M7 15h4M13 15h4M7 11h10" /></>,
  coracao: <path d="M12 20s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 10c0 5.65-7 10-7 10z" />,
  baixar: <><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" /><path d="M5 19h14" /></>,
  refazer: <><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v4.5h-4.5" /></>,
  lixeira: <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></>,
  tocar: <path d="M8 5.5v13l10.5-6.5z" />,
  pausar: <path d="M8 5v14M16 5v14" />,
  mais: <><circle cx="5.5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="18.5" cy="12" r="1" /></>,
  microfone: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  brilho: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />,
  fechar: <path d="M6 6l12 12M18 6 6 18" />,
  sol: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></>,
  lua: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  brainstorm: <><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z" /></>,
  analise: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.4-4.4M8.5 11h5M11 8.5v5" /></>,
  sair: <><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><path d="m15 16 4-4-4-4M19 12H9" /></>,
  expandir: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 3v18M13.5 9.5 16 12l-2.5 2.5" /></>,
  recolher: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M9 3v18M16 9.5 13.5 12l2.5 2.5" /></>,
}

export function Icon({ name, size = 20, filled }: { name: keyof typeof PATHS | string; size?: number; filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}
