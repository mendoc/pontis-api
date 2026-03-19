import { FastifyPluginAsync } from 'fastify'
import multipart from '@fastify/multipart'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { mkdir, unlink, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { authenticate } from '../../middleware/authenticate'
import { CreateProjectBody } from './projects.schemas'
import { ProjectError, ProjectErrorCode } from './projects.errors'
import { ProjectsService } from './projects.service'

const HTTP_STATUS: Record<ProjectErrorCode, number> = {
  PROJECT_NAME_TAKEN: 409,
  PROJECT_NOT_FOUND: 404,
  BUILD_FAILED: 500,
}

const projectsRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } })

  const svc = new ProjectsService(fastify.prisma, fastify.docker)

  // POST /upload/init — initialiser un upload chunké
  fastify.post('/upload/init', { preHandler: authenticate }, async (request, reply) => {
    const uploadId = randomUUID()
    await mkdir(join(tmpdir(), 'pontis-uploads', uploadId), { recursive: true })
    return reply.send({ uploadId })
  })

  // POST /upload/chunk — envoyer un chunk
  fastify.post('/upload/chunk', { preHandler: authenticate }, async (request, reply) => {
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
  fastify.post('/upload/finalize', { preHandler: authenticate }, async (request, reply) => {
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
      })
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // POST /upload/redeploy — assembler les chunks et redéployer un projet existant
  fastify.post('/upload/redeploy', { preHandler: authenticate }, async (request, reply) => {
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
  fastify.get('/check-slug', { preHandler: authenticate }, async (request, reply) => {
    const { slug } = request.query as { slug?: string }
    if (!slug || slug.length < 3) {
      return reply.status(400).send({ error: 'slug invalide' })
    }
    const result = await svc.checkSlug(slug)
    return reply.send(result)
  })

  // POST / — créer un projet statique
  fastify.post('/', { preHandler: authenticate }, async (request, reply) => {
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
      })
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // GET / — liste des projets de l'utilisateur
  fastify.get('/', { preHandler: authenticate }, async (request, reply) => {
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
  fastify.post('/:id/start', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const project = await svc.startProject(request.user.sub, id)
      return reply.send(project)
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // POST /:id/stop — stopper un projet
  fastify.post('/:id/stop', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const project = await svc.stopProject(request.user.sub, id)
      return reply.send(project)
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // POST /:id/restart — redémarrer un projet
  fastify.post('/:id/restart', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const project = await svc.restartProject(request.user.sub, id)
      return reply.send(project)
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // PATCH /:id — renommer un projet
  fastify.patch('/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { name } = request.body as { name?: string }

    if (!name || typeof name !== 'string' || name.trim().length < 1) {
      return reply.status(400).send({ error: 'Nom invalide' })
    }

    try {
      const project = await svc.renameProject(request.user.sub, id, name.trim())
      return reply.send(project)
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // DELETE /:id — supprimer un projet
  fastify.delete('/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await svc.deleteProject(request.user.sub, id)
      return reply.status(204).send()
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // GET /:id — détail d'un projet (pour polling)
  fastify.get('/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string }

    try {
      const project = await svc.getProject(request.user.sub, id)
      return reply.send(project)
    } catch (err) {
      if (err instanceof ProjectError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })
}

export default projectsRoutes
