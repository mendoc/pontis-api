import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import Dockerode from 'dockerode'

declare module 'fastify' {
  interface FastifyInstance {
    docker: Dockerode
  }
}

const dockerPlugin: FastifyPluginAsync = fp(async (fastify) => {
  const docker = new Dockerode({ socketPath: '/var/run/docker.sock' })

  fastify.decorate('docker', docker)
})

export default dockerPlugin
