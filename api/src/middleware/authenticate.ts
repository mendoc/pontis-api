import { FastifyRequest, FastifyReply } from 'fastify'
import { JwtPayload } from '../plugins/jwt'

declare module 'fastify' {
  interface FastifyRequest {
    user: JwtPayload
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization

  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or invalid Authorization header' })
  }

  const token = authHeader.slice(7)

  try {
    request.user = request.server.verifyAccessToken(token)
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' })
  }
}
