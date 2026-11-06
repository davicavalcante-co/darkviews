// Prazo máximo de um processo: passou disso, ele falha com uma mensagem clara e a fila segue.
// shortcut: o trabalho antigo não é morto (segue em segundo plano até acabar sozinho); matar os processos filhos se isso pesar.
export function deadline<T>(work: Promise<T>, minutes: number): Promise<T> {
  let t: NodeJS.Timeout
  const late = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`Demorou mais de ${minutes} min e foi interrompido. Clique em Tentar de novo.`)), minutes * 60_000) })
  return Promise.race([work, late]).finally(() => clearTimeout(t))
}
