import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

export const run = promisify(execFile)

// Legendas queimadas precisam de FFmpeg com libass. No Homebrew, `ffmpeg-full` traz; o `ffmpeg` comum não.
export const FFMPEG = process.env.FFMPEG_PATH
  ?? (existsSync('/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg') ? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg' : 'ffmpeg')
export const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe')

export async function assertLibass() {
  const { stdout } = await run(FFMPEG, ['-hide_banner', '-filters'], { maxBuffer: 8 * 1024 * 1024 })
  if (!/\ssubtitles\s/.test(stdout)) throw new Error('O FFmpeg instalado não tem libass (legendas). Instale com: brew install ffmpeg-full')
}

export async function durationOf(path: string) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path])
  return Number(stdout.trim()) || 0
}
