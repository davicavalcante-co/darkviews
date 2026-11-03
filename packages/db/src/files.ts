import { open } from 'node:fs/promises'

export type Sniffed = { kind: 'image' | 'video'; mime: string; ext: string }

// Tipo real pelos primeiros bytes (assinatura do arquivo), não pela extensão.
export function sniff(b: Buffer): Sniffed | null {
  if (b.length < 12) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' }
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', mime: 'image/png', ext: 'png' }
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: 'webp' }
  if (b.toString('latin1', 4, 8) === 'ftyp') {
    return b.toString('latin1', 8, 10) === 'qt'
      ? { kind: 'video', mime: 'video/quicktime', ext: 'mov' }
      : { kind: 'video', mime: 'video/mp4', ext: 'mp4' }
  }
  if (b.readUInt32BE(0) === 0x1a45dfa3) return { kind: 'video', mime: 'video/webm', ext: 'webm' }
  return null
}

export async function sniffFile(path: string) {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(16)
    await fh.read(buf, 0, 16, 0)
    return sniff(buf)
  } finally { await fh.close() }
}
