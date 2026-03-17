import { FastifyPluginAsync } from 'fastify'
import multipart from '@fastify/multipart'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { unlink, readFile } from 'node:fs/promises'
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
    const projects = await svc.listProjects(request.user.sub)
    return reply.send(projects)
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
