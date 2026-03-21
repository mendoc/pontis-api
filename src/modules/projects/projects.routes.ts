import { FastifyPluginAsync } from 'fastify'
import multipart from '@fastify/multipart'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { mkdir, unlink, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { authenticate } from '../../middleware/authenticate'
import { requirePermission } from '../../middleware/requirePermission'
import { CreateProjectBody } from './projects.schemas'
import { ProjectError, ProjectErrorCode } from './projects.errors'
import { ProjectsService } from './projects.service'

const HTTP_STATUS: Record<ProjectErrorCode, number> = {
  PROJECT_NAME_TAKEN: 409,
  PROJECT_NOT_FOUND: 404,
  BUILD_FAILED: 500,
  DEPLOYMENT_NOT_FOUND: 404,
  DEPLOYMENT_IN_USE: 409,
  DEPLOYMENT_BUILDING: 409,
}

const projectsRoutes: FastifyPluginAsync = async (fastify) => {
  // Pour les admins, pas de filtre par userId — ils peuvent accéder à tous les projets
  const uid = (req: Parameters<typeof authenticate>[0]) =>
    req.user.role === 'admin' ? undefined : req.user.sub

  await fastify.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } })

  const svc = new ProjectsService(fastify.prisma, fastify.docker)

  // POST /upload/init — initialiser un upload chunké
  fastify.post('/upload/init', { preHandler: [authenticate, requirePermission('projects:create')] }, async (request, reply) => {
    const uploadId = randomUUID()
    await mkdir(join(tmpdir(), 'pontis-uploads', uploadId), { recursive: true })
    return reply.send({ uploadId })
  })

  // POST /upload/chunk — envoyer un chunk
  fastify.post('/upload/chunk', { preHandler: [authenticate, requirePermission('projects:create')] }, async (request, reply) => {
    const parts = request.parts()
    let uploadId: string | undefined
    let chunkIndex: string | undefined

    for await (const part of parts) {
      if (part.type === 'field' && part.fieldname === 'uploadId') {
        uploadId = part.value as string
      } else if (part.type === 'field' && part.fieldname === 'chunkIndex') {
        chunkIndex = part.value as string
      } else if (part.type === 'file' && part.fieldname === 'chunk') {
        if (!uploadId || !chunkIndex) {
          // consume stream to avoid leak
          part.file.resume()
          continue
        }
        const chunkPath = join(tmpdir(), 'pontis-uploads', uploadId, chunkIndex)
        await pipeline(part.file, createWriteStream(chunkPath))
      }
    }

    if (!uploadId || !chunkIndex) {
      return reply.status(400).send({ error: 'uploadId et chunkIndex requis' })
    }

    return reply.send({ ok: true })
  })

  // POST /upload/finalize — assembler les chunks et créer le projet
  fastify.post('/upload/finalize', { preHandler: [authenticate, requirePermission('projects:create')] }, async (request, reply) => {
    const { name, uploadId, totalChunks } = request.body as {
      name: string
      uploadId: string
      totalChunks: number
    }

    if (!name || !uploadId || !totalChunks) {
      return reply.status(400).send({ error: 'name, uploadId et totalChunks requis' })
    }

    const uploadDir = join(tmpdir(), 'pontis-uploads', uploadId)
    let zipBuffer: Buffer

    try {
      const chunks: Buffer[] = []
      for (let i = 0; i < totalChunks; i++) {
        const chunkPath = join(uploadDir, String(i))
        chunks.push(await readFile(chunkPath))
      }
      zipBuffer = Buffer.concat(chunks)
    } finally {
      await rm(uploadDir, { recursive: true, force: true })
    }

    if (!zipBuffer || zipBuffer.length === 0) {
      return reply.status(400).send({ error: 'Fichier ZIP requis' })
    }

    const parsed = CreateProjectBody.safeParse({ name })
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    try {
      const project = await svc.createProject(request.user.sub, parsed.data.name, zipBuffer)
      return reply.status(201).send({
        id: project.id,
        name: project.name,
        slug: project.slug,
        status: project.status,
        domain: project.domain ?? null,
        deploymentId: project.deploymentId,
      })
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // POST /upload/redeploy — assembler les chunks et redéployer un projet existant
  fastify.post('/upload/redeploy', { preHandler: [authenticate, requirePermission('projects:deploy')] }, async (request, reply) => {
    const { projectId, uploadId, totalChunks } = request.body as {
      projectId: string
      uploadId: string
      totalChunks: number
    }

    if (!projectId || !uploadId || !totalChunks) {
      return reply.status(400).send({ error: 'projectId, uploadId et totalChunks requis' })
    }

    const uploadDir = join(tmpdir(), 'pontis-uploads', uploadId)
    let zipBuffer: Buffer

    try {
      const chunks: Buffer[] = []
      for (let i = 0; i < totalChunks; i++) {
        chunks.push(await readFile(join(uploadDir, String(i))))
      }
      zipBuffer = Buffer.concat(chunks)
    } finally {
      await rm(uploadDir, { recursive: true, force: true })
    }

    if (!zipBuffer || zipBuffer.length === 0) {
      return reply.status(400).send({ error: 'Fichier ZIP requis' })
    }

    try {
      const project = await svc.redeployProject(request.user.sub, projectId, zipBuffer)
      return reply.send(project)
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // GET /check-slug?slug= — vérifier la disponibilité d'un slug
  fastify.get('/check-slug', { preHandler: [authenticate, requirePermission('projects:create')] }, async (request, reply) => {
    const { slug } = request.query as { slug?: string }
    if (!slug || slug.length < 3) {
      return reply.status(400).send({ error: 'slug invalide' })
    }
    const result = await svc.checkSlug(slug)
    return reply.send(result)
  })

  // POST / — créer un projet statique
  fastify.post('/', { preHandler: [authenticate, requirePermission('projects:create')] }, async (request, reply) => {
    const parts = request.parts()
    let name: string | undefined
    let zipBuffer: Buffer | undefined

    const tmpPath = join(tmpdir(), `${randomUUID()}.zip`)
    try {
      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'name') {
          name = part.value as string
        } else if (part.type === 'file' && part.fieldname === 'file') {
          await pipeline(part.file, createWriteStream(tmpPath))
        }
      }
      zipBuffer = await readFile(tmpPath)
    } finally {
      await unlink(tmpPath).catch(() => null)
    }

    const parsed = CreateProjectBody.safeParse({ name })
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    if (!zipBuffer || zipBuffer.length === 0) {
      return reply.status(400).send({ error: 'Fichier ZIP requis' })
    }

    try {
      const project = await svc.createProject(request.user.sub, parsed.data.name, zipBuffer)
      return reply.status(201).send({
        id: project.id,
        name: project.name,
        slug: project.slug,
        status: project.status,
        domain: project.domain ?? null,
        deploymentId: project.deploymentId,
      })
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // GET / — liste des projets de l'utilisateur
  fastify.get('/', { preHandler: [authenticate, requirePermission('projects:list')] }, async (request, reply) => {
    const { page, limit, search, sortBy, sortOrder } = request.query as { page?: string; limit?: string; search?: string; sortBy?: string; sortOrder?: 'asc' | 'desc' }
    const result = await svc.listProjects(request.user.sub, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      search,
      sortBy,
      sortOrder,
    })
    return reply.send(result)
  })

  // POST /:id/start — démarrer un projet
  fastify.post('/:id/start', { preHandler: [authenticate, requirePermission('projects:start')] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const project = await svc.startProject(uid(request), id)
      return reply.send(project)
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // POST /:id/stop — stopper un projet
  fastify.post('/:id/stop', { preHandler: [authenticate, requirePermission('projects:stop')] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const project = await svc.stopProject(uid(request), id)
      return reply.send(project)
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // POST /:id/restart — redémarrer un projet
  fastify.post('/:id/restart', { preHandler: [authenticate, requirePermission('projects:restart')] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const project = await svc.restartProject(uid(request), id)
      return reply.send(project)
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // --- Routes de debug (step-by-step) ---

  // POST /:id/debug/container-stop
  fastify.post('/:id/debug/container-stop', { preHandler: [authenticate, requirePermission('projects:debug')] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await svc.debugContainerStop(request.user.sub, id)
    return reply.send(result)
  })

  // POST /:id/debug/container-remove
  fastify.post('/:id/debug/container-remove', { preHandler: [authenticate, requirePermission('projects:debug')] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await svc.debugContainerRemove(request.user.sub, id)
    return reply.send(result)
  })

  // POST /:id/debug/container-create
  fastify.post('/:id/debug/container-create', { preHandler: [authenticate, requirePermission('projects:debug')] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await svc.debugContainerCreate(request.user.sub, id)
    return reply.send(result)
  })

  // POST /:id/debug/container-start
  fastify.post('/:id/debug/container-start', { preHandler: [authenticate, requirePermission('projects:debug')] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await svc.debugContainerStart(request.user.sub, id)
    return reply.send(result)
  })

  // GET /:id/debug/container-inspect
  fastify.get('/:id/debug/container-inspect', { preHandler: [authenticate, requirePermission('projects:debug')] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await svc.debugContainerInspect(request.user.sub, id)
    return reply.send(result)
  })

  // GET /:id/deployments — liste des déploiements d'un projet
  fastify.get('/:id/deployments', { preHandler: [authenticate, requirePermission('projects:deployments:list')] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { page, limit } = request.query as { page?: string; limit?: string }
    try {
      const result = await svc.listDeployments(uid(request), id, {
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      })
      return reply.send(result)
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // GET /:id/deployments/:deploymentId — détail d'un déploiement
  fastify.get('/:id/deployments/:deploymentId', { preHandler: [authenticate, requirePermission('projects:deployments:read')] }, async (request, reply) => {
    const { id, deploymentId } = request.params as { id: string; deploymentId: string }
    try {
      const deployment = await svc.getDeployment(uid(request), id, deploymentId)
      return reply.send(deployment)
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // DELETE /:id/deployments/:deploymentId — supprimer un déploiement
  fastify.delete('/:id/deployments/:deploymentId', { preHandler: [authenticate, requirePermission('projects:deployments:delete')] }, async (request, reply) => {
    const { id, deploymentId } = request.params as { id: string; deploymentId: string }
    try {
      await svc.deleteDeployment(uid(request), id, deploymentId)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // POST /:id/deployments/:deploymentId/rollback — rollback vers un déploiement précédent
  fastify.post('/:id/deployments/:deploymentId/rollback', { preHandler: [authenticate, requirePermission('projects:deployments:rollback')] }, async (request, reply) => {
    const { id, deploymentId } = request.params as { id: string; deploymentId: string }
    try {
      const project = await svc.rollbackDeployment(uid(request), id, deploymentId)
      return reply.send(project)
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // PATCH /:id — renommer un projet
  fastify.patch('/:id', { preHandler: [authenticate, requirePermission('projects:update')] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { name } = request.body as { name?: string }

    if (!name || typeof name !== 'string' || name.trim().length < 1) {
      return reply.status(400).send({ error: 'Nom invalide' })
    }

    try {
      const project = await svc.renameProject(uid(request), id, name.trim())
      return reply.send(project)
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // DELETE /:id — supprimer un projet
  fastify.delete('/:id', { preHandler: [authenticate, requirePermission('projects:delete')] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await svc.deleteProject(uid(request), id)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // GET /:id — détail d'un projet (pour polling)
  fastify.get('/:id', { preHandler: [authenticate, requirePermission('projects:read')] }, async (request, reply) => {
    const { id } = request.params as { id: string }

    try {
      const project = await svc.getProject(uid(request), id, request.user.role === 'admin')
      return reply.send(project)
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })
}

export default projectsRoutes
