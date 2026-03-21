import { FastifyRequest, FastifyReply } from 'fastify'
import { Permission, hasPermission } from '../config/permissions'

export function requirePermission(permission: Permission) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!hasPermission(request.user.role, permission)) {
      return reply.status(403).send({ error: 'Forbidden' })
    }
  }
}
