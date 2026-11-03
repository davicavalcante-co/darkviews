import type { FastifyReply, FastifyRequest } from 'fastify'

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: 'Não autenticado' })
}
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: 'Não autenticado' })
  if (req.user.role !== 'admin') return reply.code(403).send({ error: 'Sem permissão' })
}
