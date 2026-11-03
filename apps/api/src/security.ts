import { createHash, randomBytes } from 'node:crypto'

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
export const newToken = () => randomBytes(32).toString('base64url')
// O token CSRF é derivado do token da sessão: não precisa de tabela extra e morre junto com ela.
export const csrfFor = (sessionToken: string) => sha256('csrf:' + sessionToken)
