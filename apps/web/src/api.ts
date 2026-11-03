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
  useEffect(() => { api<string[]>('/fonts').then(setFonts).catch(() => {}) }, [])
  return fonts
}
