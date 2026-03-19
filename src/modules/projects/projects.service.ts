import { PrismaClient } from '@prisma/client'
import Dockerode from 'dockerode'
import { ProjectError } from './projects.errors'
import { buildAndRunStaticProject } from '../../lib/static-builder'

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export class ProjectsService {
  constructor(
    private prisma: PrismaClient,
    private docker: Dockerode
  ) {}

  async checkSlug(slug: string): Promise<{ available: boolean }> {
    const existing = await this.prisma.project.findUnique({ where: { slug } })
    return { available: !existing }
  }

  async createProject(userId: string, name: string, zipBuffer: Buffer) {
    const slug = slugify(name)

    const existing = await this.prisma.project.findUnique({ where: { slug } })
    if (existing) throw new ProjectError('PROJECT_NAME_TAKEN', 'Ce slug est déjà utilisé')

    const project = await this.prisma.project.create({
      data: {
        userId,
        name,
        slug,
        type: 'static',
        status: 'building',
      },
    })

    // Fire-and-forget : build en arrière-plan
    buildAndRunStaticProject(this.docker, project.id, slug, zipBuffer)
      .then(async (domain) => {
        await this.prisma.project.update({
          where: { id: project.id },
          data: { status: 'running', domain },
        })
      })
      .catch(async () => {
        await this.prisma.project.update({
          where: { id: project.id },
          data: { status: 'failed' },
        })
      })

    return project
  }

  // Labels français → valeurs brutes stockées en base
  private static readonly STATUS_FR: Array<[string, string]> = [
    ['en ligne', 'running'],
    ['en cours', 'building'],
    ['arrete',   'stopped'],
    ['echoue',   'failed'],
  ]

  private normalizeStr(s: string): string {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  }

  private static readonly SORTABLE_FIELDS = ['name', 'domain', 'status', 'type', 'createdAt'] as const

  async listProjects(userId: string, opts: { page?: number; limit?: number; search?: string; sortBy?: string; sortOrder?: 'asc' | 'desc' } = {}) {
    const page = Math.max(1, opts.page ?? 1)
    const limit = Math.min(100, Math.max(1, opts.limit ?? 10))
    const sortField = ProjectsService.SORTABLE_FIELDS.includes(opts.sortBy as never) ? opts.sortBy! : 'createdAt'
    const sortOrder = opts.sortOrder === 'asc' ? 'asc' : 'desc'
    const search = opts.search?.trim()

    // Résout un éventuel label français vers la valeur brute du statut
    const normalizedSearch = search ? this.normalizeStr(search) : ''
    const resolvedStatus = normalizedSearch
      ? ProjectsService.STATUS_FR.find(([label]) => label.includes(normalizedSearch))?.[1]
      : undefined

    // type est une enum (git | static) — on ne peut pas utiliser contains
    const PROJECT_TYPES = ['git', 'static'] as const
    type ProjectTypeVal = typeof PROJECT_TYPES[number]
    const matchedType = search
      ? PROJECT_TYPES.find((t) => t.includes(search.toLowerCase())) as ProjectTypeVal | undefined
      : undefined

    const where = {
      userId,
      ...(search ? {
        OR: [
          { name:   { contains: search, mode: 'insensitive' as const } },
          { slug:   { contains: search, mode: 'insensitive' as const } },
          { domain: { contains: search, mode: 'insensitive' as const } },
          { status: { contains: search, mode: 'insensitive' as const } },
          ...(resolvedStatus ? [{ status: { equals: resolvedStatus } }] : []),
          ...(matchedType   ? [{ type:   { equals: matchedType   } }] : []),
        ],
      } : {}),
    }

    const select = { id: true, name: true, slug: true, type: true, status: true, domain: true, createdAt: true }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.project.findMany({ where, orderBy: { [sortField]: sortOrder }, select, skip: (page - 1) * limit, take: limit }),
      this.prisma.project.count({ where }),
    ])

    return { data, total, page, limit }
  }

  async getProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true, name: true, slug: true, type: true, status: true, domain: true, createdAt: true },
    })

    if (!project) {
      throw new ProjectError('PROJECT_NOT_FOUND', 'Projet introuvable')
    }

    return project
  }

  async startProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, userId } })
    if (!project) throw new ProjectError('PROJECT_NOT_FOUND', 'Projet introuvable')

    try {
      const container = this.docker.getContainer(`pontis-${project.slug}`)
      await container.start()
    } catch {
      // Container inexistant ou déjà démarré
    }

    return this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'running' },
      select: { id: true, name: true, slug: true, type: true, status: true, domain: true, createdAt: true },
    })
  }

  async stopProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, userId } })
    if (!project) throw new ProjectError('PROJECT_NOT_FOUND', 'Projet introuvable')

    try {
      const container = this.docker.getContainer(`pontis-${project.slug}`)
      await container.stop()
    } catch {
      // Container déjà arrêté ou inexistant
    }

    return this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'stopped' },
      select: { id: true, name: true, slug: true, type: true, status: true, domain: true, createdAt: true },
    })
  }

  async restartProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, userId } })
    if (!project) throw new ProjectError('PROJECT_NOT_FOUND', 'Projet introuvable')

    try {
      const container = this.docker.getContainer(`pontis-${project.slug}`)
      await container.restart()
    } catch {
      // Container inexistant ou erreur Docker
    }

    return this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'running' },
      select: { id: true, name: true, slug: true, type: true, status: true, domain: true, createdAt: true },
    })
  }

  async redeployProject(userId: string, projectId: string, zipBuffer: Buffer) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, userId } })
    if (!project) throw new ProjectError('PROJECT_NOT_FOUND', 'Projet introuvable')

    await this.prisma.project.update({ where: { id: projectId }, data: { status: 'building' } })

    buildAndRunStaticProject(this.docker, project.id, project.slug, zipBuffer)
      .then(async () => {
        await this.prisma.project.update({ where: { id: projectId }, data: { status: 'running' } })
      })
      .catch(async () => {
        await this.prisma.project.update({ where: { id: projectId }, data: { status: 'failed' } })
      })

    return this.prisma.project.findFirst({
      where: { id: projectId },
      select: { id: true, name: true, slug: true, type: true, status: true, domain: true, createdAt: true },
    })
  }

  async renameProject(userId: string, projectId: string, name: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, userId } })
    if (!project) throw new ProjectError('PROJECT_NOT_FOUND', 'Projet introuvable')

    return this.prisma.project.update({
      where: { id: projectId },
      data: { name },
      select: { id: true, name: true, slug: true, type: true, status: true, domain: true, createdAt: true },
    })
  }

  async deleteProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, userId } })
    if (!project) throw new ProjectError('PROJECT_NOT_FOUND', 'Projet introuvable')

    try {
      const container = this.docker.getContainer(`pontis-${project.slug}`)
      await container.stop().catch(() => null)
      await container.remove().catch(() => null)
    } catch { /* ignore */ }

    try {
      const image = this.docker.getImage(`pontis-${project.slug}:latest`)
      await image.remove({ force: true }).catch(() => null)
    } catch { /* ignore */ }

    await this.prisma.project.delete({ where: { id: projectId } })
  }
}
