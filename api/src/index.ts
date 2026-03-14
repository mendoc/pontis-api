import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'

import prismaPlugin from './plugins/prisma'
import jwtPlugin from './plugins/jwt'
import healthRoutes from './routes/health'
import authRoutes from './routes/auth'

const PORT = parseInt(process.env.PORT ?? '3001', 10)
const HOST = '0.0.0.0'

async function main() {
  const fastify = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport:
        process.env.NODE_ENV !== 'production'
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
  await fastify.register(prismaPlugin)
  await fastify.register(jwtPlugin)

  // Routes
  await fastify.register(healthRoutes)
  await fastify.register(authRoutes, { prefix: '/auth' })

  try {
    await fastify.listen({ port: PORT, host: HOST })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

main()
