import { useEffect, useState } from 'react'

let csrfToken = ''
export const setCsrf = (t: string) => { csrfToken = t }

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    // FormData define o próprio content-type (multipart com boundary); sem corpo, não declara JSON (a API recusaria).
    headers: init.body === undefined || init.body instanceof FormData ? { 'x-csrf-token': csrfToken } : { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: init.body === undefined || init.body instanceof FormData ? (init.body as FormData | undefined) : JSON.stringify(init.body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error ?? 'Erro'), { status: res.status })
  return data as T
}

// Fontes liberadas pelo admin para as legendas.
export function useFonts() {
  const [fonts, setFonts] = useState<string[]>([])
  useEffect(() => {
    const load = () => api<string[]>('/fonts').then(setFonts).catch(() => {})
    load()
    // Fonte enviada em qualquer tela atualiza todas as listas.
    addEventListener('fonts-changed', load)
    return () => removeEventListener('fonts-changed', load)
  }, [])
  return fonts
}

// Envia um arquivo de fonte (.ttf/.otf); devolve o nome lido de dentro do arquivo.
export async function uploadFont(file: File) {
  const body = new FormData(); body.append('font', file)
  const r = await api<{ family: string }>('/fonts/upload', { method: 'POST', body })
  dispatchEvent(new Event('fonts-changed'))
  return r.family
}
