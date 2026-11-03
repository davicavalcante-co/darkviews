import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// O navegador só fala com a API local, pelo proxy (mesma origem, cookie SameSite=Strict funciona).
export default defineConfig({
  plugins: [react()],
  server: { host: 'localhost', port: 5173, proxy: { '/api': 'http://127.0.0.1:3333' } },
})
