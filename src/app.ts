import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { PrismaClient } from '@prisma/client'

import prismaPlugin from './plugins/prisma'
import jwtPlugin from './plugins/jwt'
import dockerPlugin from './plugins/docker'
import healthRoutes from './routes/health'
import authRoutes from './modules/auth/auth.routes'
import projectsRoutes from './modules/projects/projects.routes'
import usersRoutes from './modules/users/users.routes'
import adminRoutes from './modules/admin/admin.routes'

export interface BuildAppOptions {
  prismaOverride?: PrismaClient
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<ReturnType<typeof Fastify>> {
  const fastify = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'test' ? 'silent' : process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport:
        process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  })

  // Plugins
  await fastify.register(cors, {
    origin: process.env.CORS_ORIGIN ?? true,
    credentials: true,
  })
  await fastify.register(cookie)

  if (opts.prismaOverride) {
    fastify.decorate('prisma', opts.prismaOverride)
  } else {
    await fastify.register(prismaPlugin)
  }

  await fastify.register(jwtPlugin)
  await fastify.register(dockerPlugin)

  // Routes
  const API_PREFIX = '/api/v1'
  await fastify.register(healthRoutes, { prefix: API_PREFIX })
  await fastify.register(authRoutes, { prefix: `${API_PREFIX}/auth` })
  await fastify.register(projectsRoutes, { prefix: `${API_PREFIX}/projects` })
  await fastify.register(usersRoutes, { prefix: `${API_PREFIX}/users` })
  await fastify.register(adminRoutes, { prefix: `${API_PREFIX}/admin` })

  return fastify
}
