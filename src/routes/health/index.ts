import { FastifyPluginAsync } from 'fastify'

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', { logLevel: 'silent' }, async () => {
    return { status: 'ok' }
  })
}

export default healthRoutes
