import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { prisma, projectDir, sniffFile, STORAGE_DIR, type Job } from '@corte/db'
import { detectPlatform } from '@corte/shared'

const run = promisify(execFile)

async function stage(job: Job, stage: string, progress: number) {
  await prisma.job.update({ where: { id: job.id }, data: { stage, progress } })
}

// Argumentos separados, nunca concatenados num shell; o link já passou pela lista de domínios.
// dir: pasta do projeto (referência de um vídeo); sem ela, a pasta das análises (o vídeo é apagado depois).
export async function download(url: string, dir = join(STORAGE_DIR, 'analises')) {
  if (!detectPlatform(url)) throw new Error('Link fora da lista de plataformas permitidas')
  await mkdir(dir, { recursive: true })
  const id = randomUUID()
  try {
    const { stdout } = await run('yt-dlp', [
      '--no-playlist', '--max-filesize', '2G', '-f', 'mp4/bestvideo*+bestaudio/best', '--merge-output-format', 'mp4',
      '-o', join(dir, `${id}.%(ext)s`), '--print', 'before_dl:%(title)s\t%(channel,uploader|)s', '--print', 'after_move:filepath', '--', url,
    ], { maxBuffer: 1024 * 1024, timeout: 30 * 60_000 })
    const lines = stdout.trim().split('\n')
    const [title, channel] = lines.length > 1 ? lines[0].split('\t') : []
    return { path: lines.at(-1)!, title: title || null, channel: channel || null }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('yt-dlp não está instalado nesta máquina (veja o README)')
    throw new Error('Não foi possível baixar a referência: ' + ((e as { stderr?: string }).stderr ?? '').split('\n').filter(Boolean).pop())
  }
}

export async function probeDuration(path: string) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path])
    return Number(JSON.parse(stdout).format?.duration) || null
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('FFmpeg/ffprobe não está instalado nesta máquina (veja o README)')
    throw new Error('Arquivo de vídeo ilegível')
  }
}

export async function ingest(job: Job) {
  const project = await prisma.project.update({ where: { id: job.projectId }, data: { status: 'analyzing' }, include: { reference: true } })
  const ref = project.reference
  if (ref) {
    let filePath = ref.filePath
    if (ref.sourceType === 'link') {
      await stage(job, 'Baixando referência', 10)
      filePath = (await download(ref.url!, await projectDir(job.projectId, 'referencia'))).path
      const type = await sniffFile(filePath)
      if (type?.kind !== 'video') { await rm(filePath, { force: true }); throw new Error('O link não devolveu um vídeo válido') }
    }
    await stage(job, 'Lendo metadados', 70)
    const durationS = await probeDuration(filePath!)
    await prisma.reference.update({ where: { id: ref.id }, data: { filePath, durationS } })
  }
  // Próxima etapa: análise com o Claude (Fase 3). Fica na fila até lá.
  await prisma.job.create({ data: { projectId: project.id, type: 'analyze', stage: 'Aguardando análise' } })
}
