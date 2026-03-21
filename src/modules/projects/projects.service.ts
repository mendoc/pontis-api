import { PrismaClient } from '@prisma/client'
import Dockerode from 'dockerode'
import { ProjectError } from './projects.errors'
import { buildAndRunStaticProject } from '../../lib/static-builder'
import { removeProjectDir, writeProjectCompose } from '../../lib/compose-writer'

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

const PROJECT_SELECT = {
  id: true,
  name: true,
  slug: true,
  type: true,
  status: true,
  domain: true,
  createdAt: true,
  restartedAt: true,
  currentDeploymentId: true,
} as const

const PROJECT_SELECT_WITH_USER = {
  ...PROJECT_SELECT,
  user: { select: { id: true, email: true, name: true } },
} as const

function dockerErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function isAlreadyStarted(err: unknown): boolean {
  return dockerErrorMessage(err).toLowerCase().includes('already started')
}

function isNoSuchContainer(err: unknown): boolean {
  const msg = dockerErrorMessage(err).toLowerCase()
  return msg.includes('no such container') || msg.includes('404')
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
      data: { userId, name, slug, type: 'static', status: 'building' },
    })

    const deployment = await this.prisma.deployment.create({
      data: { projectId: project.id, status: 'building' },
    })

    // Fire-and-forget : build en arrière-plan
    buildAndRunStaticProject(this.docker, project.id, slug, zipBuffer, deployment.id)
      .then(async ({ domain, logs }) => {
        const imageTag = `pontis-${slug}:deploy-${deployment.id}`
        await this.prisma.deployment.update({
          where: { id: deployment.id },
          data: { status: 'success', logs, imageTag, finishedAt: new Date() },
        })
        await this.prisma.project.update({
          where: { id: project.id },
          data: { status: 'running', domain, currentDeploymentId: deployment.id },
        })
      })
      .catch(async (err) => {
        const errorMsg = dockerErrorMessage(err)
        console.error('[createProject] build failed:', errorMsg)
        await this.prisma.deployment.update({
          where: { id: deployment.id },
          data: { status: 'failed', logs: errorMsg, finishedAt: new Date() },
        })
        await this.prisma.project.update({
          where: { id: project.id },
          data: { status: 'failed' },
        })
      })

    return { ...project, deploymentId: deployment.id }
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

    const normalizedSearch = search ? this.normalizeStr(search) : ''
    const resolvedStatus = normalizedSearch
      ? ProjectsService.STATUS_FR.find(([label]) => label.includes(normalizedSearch))?.[1]
      : undefined

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

    const [rawData, total] = await this.prisma.$transaction([
      this.prisma.project.findMany({
        where,
        orderBy: { [sortField]: sortOrder },
        select: {
          ...select,
          deployments: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.project.count({ where }),
    ])

    const data = rawData.map(({ deployments, ...p }) => ({
      ...p,
      lastDeployedAt: deployments[0]?.createdAt?.toISOString() ?? null,
    }))

    return { data, total, page, limit }
  }

  private async assertAccess(projectId: string, requesterId: string, requesterRole: 'developer' | 'admin') {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } })
    if (!project) throw new ProjectError('PROJECT_NOT_FOUND', 'Projet introuvable')
    if (project.userId !== requesterId && requesterRole !== 'admin') {
      throw new ProjectError('PROJECT_FORBIDDEN', 'Accès non autorisé à ce projet')
    }
    return project
  }

  async getProject(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string, includeUser = false) {
    const raw = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ...PROJECT_SELECT, userId: true, ...(includeUser ? { user: { select: { id: true, email: true, name: true } } } : {}) },
    })

    if (!raw) throw new ProjectError('PROJECT_NOT_FOUND', 'Projet introuvable')
    if (raw.userId !== requesterId && requesterRole !== 'admin') {
      throw new ProjectError('PROJECT_FORBIDDEN', 'Accès non autorisé à ce projet')
    }

    const { userId: _uid, ...project } = raw
    return project
  }

  async startProject(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string) {
    const project = await this.assertAccess(projectId, requesterId, requesterRole)


    try {
      await this.docker.getContainer(`pontis-${project.slug}`).start()
    } catch (err) {
      if (isAlreadyStarted(err)) {
        // Déjà démarré — pas un problème
      } else if (isNoSuchContainer(err)) {
        throw new ProjectError('PROJECT_NOT_FOUND', 'Le container est introuvable. Essayez de redémarrer le projet depuis un redéploiement.')
      } else {
        throw new ProjectError('BUILD_FAILED', `Impossible de démarrer le container : ${dockerErrorMessage(err)}`)
      }
    }

    return this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'running' },
      select: PROJECT_SELECT,
    })
  }

  async stopProject(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string) {
    const project = await this.assertAccess(projectId, requesterId, requesterRole)

    try {
      await this.docker.getContainer(`pontis-${project.slug}`).stop()
    } catch {
      // Container déjà arrêté ou inexistant — l'état final voulu est atteint
    }

    return this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'stopped' },
      select: PROJECT_SELECT,
    })
  }

  async restartProject(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string) {
    const project = await this.assertAccess(projectId, requesterId, requesterRole)

    const containerName = `pontis-${project.slug}`
    const imageTag = `pontis-${project.slug}:latest`
    const domain = project.domain ?? `${project.slug}.${process.env.APP_DOMAIN ?? 'app.ongoua.pro'}`
    const network = process.env.DOCKER_NETWORK ?? 'pontis_network'
    const slug = project.slug

    // Supprimer le container existant (force: true gère tous les états)
    try {
      await this.docker.getContainer(containerName).remove({ force: true })
    } catch {
      // Container inexistant — pas un problème
    }

    try {
      const container = await this.docker.createContainer({
        Image: imageTag,
        name: containerName,
        Labels: {
          'traefik.enable': 'true',
          [`traefik.http.routers.${slug}.rule`]: `Host(\`${domain}\`)`,
          [`traefik.http.routers.${slug}.entrypoints`]: 'websecure',
          [`traefik.http.routers.${slug}.tls`]: 'true',
          [`traefik.http.routers.${slug}.tls.certresolver`]: 'letsencrypt',
          [`traefik.http.services.${slug}.loadbalancer.server.port`]: '80',
        },
        HostConfig: { NetworkMode: network },
      })
      await container.start()
    } catch (err) {
      throw new ProjectError('BUILD_FAILED', `Impossible de recréer le container : ${dockerErrorMessage(err)}`)
    }

    return this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'running', restartedAt: new Date() },
      select: PROJECT_SELECT,
    })
  }

  async redeployProject(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string, zipBuffer: Buffer) {
    const project = await this.assertAccess(projectId, requesterId, requesterRole)

    await this.prisma.project.update({ where: { id: projectId }, data: { status: 'building' } })

    const deployment = await this.prisma.deployment.create({
      data: { projectId, status: 'building' },
    })

    buildAndRunStaticProject(this.docker, project.id, project.slug, zipBuffer, deployment.id)
      .then(async ({ domain, logs }) => {
        const imageTag = `pontis-${project.slug}:deploy-${deployment.id}`
        await this.prisma.deployment.update({
          where: { id: deployment.id },
          data: { status: 'success', logs, imageTag, finishedAt: new Date() },
        })
        await this.prisma.project.update({ where: { id: projectId }, data: { status: 'running', domain, currentDeploymentId: deployment.id } })
      })
      .catch(async (err) => {
        const errorMsg = dockerErrorMessage(err)
        console.error('[redeployProject] build failed:', errorMsg)
        await this.prisma.deployment.update({
          where: { id: deployment.id },
          data: { status: 'failed', logs: errorMsg, finishedAt: new Date() },
        })
        // Si un déploiement était déjà en production, son container est toujours actif — on y revient.
        const revertStatus = project.currentDeploymentId ? 'running' : 'failed'
        await this.prisma.project.update({ where: { id: projectId }, data: { status: revertStatus } })
      })

    const updatedProject = await this.prisma.project.findFirst({
      where: { id: projectId },
      select: PROJECT_SELECT,
    })

    return { ...updatedProject!, deploymentId: deployment.id }
  }

  async listDeployments(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string, opts: { page?: number; limit?: number } = {}) {
    const project = await this.assertAccess(projectId, requesterId, requesterRole)

    const page = Math.max(1, opts.page ?? 1)
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50))

    const [data, total] = await this.prisma.$transaction([
      this.prisma.deployment.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.deployment.count({ where: { projectId } }),
    ])

    return { data, total, page, limit, currentDeploymentId: project.currentDeploymentId ?? null }
  }

  async getDeployment(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string, deploymentId: string) {
    await this.assertAccess(projectId, requesterId, requesterRole)

    const deployment = await this.prisma.deployment.findFirst({
      where: { id: deploymentId, projectId },
    })

    if (!deployment) throw new ProjectError('DEPLOYMENT_NOT_FOUND', 'Déploiement introuvable')

    return deployment
  }

  async rollbackDeployment(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string, deploymentId: string) {
    const project = await this.assertAccess(projectId, requesterId, requesterRole)

    const deployment = await this.prisma.deployment.findFirst({
      where: { id: deploymentId, projectId, status: 'success' },
    })

    if (!deployment?.imageTag) {
      throw new ProjectError('DEPLOYMENT_NOT_FOUND', 'Déploiement introuvable ou sans image versionnée')
    }

    const containerName = `pontis-${project.slug}`
    const domain = project.domain ?? `${project.slug}.${process.env.APP_DOMAIN ?? 'app.ongoua.pro'}`
    const network = process.env.DOCKER_NETWORK ?? 'pontis_network'
    const slug = project.slug

    // Supprimer le container existant (force: true gère tous les états)
    try {
      await this.docker.getContainer(containerName).remove({ force: true })
    } catch {
      // Container inexistant — pas un problème
    }

    try {
      const container = await this.docker.createContainer({
        Image: deployment.imageTag,
        name: containerName,
        Labels: {
          'traefik.enable': 'true',
          [`traefik.http.routers.${slug}.rule`]: `Host(\`${domain}\`)`,
          [`traefik.http.routers.${slug}.entrypoints`]: 'websecure',
          [`traefik.http.routers.${slug}.tls`]: 'true',
          [`traefik.http.routers.${slug}.tls.certresolver`]: 'letsencrypt',
          [`traefik.http.services.${slug}.loadbalancer.server.port`]: '80',
        },
        HostConfig: { NetworkMode: network },
      })
      await container.start()
      await writeProjectCompose(slug, domain, network, deployment.imageTag).catch(() => null)
    } catch (err) {
      throw new ProjectError('BUILD_FAILED', `Impossible de restaurer le container : ${dockerErrorMessage(err)}`)
    }

    return this.prisma.project.update({
      where: { id: projectId },
      data: { status: 'running', currentDeploymentId: deploymentId },
      select: PROJECT_SELECT,
    })
  }

  async renameProject(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string, name: string) {
    await this.assertAccess(projectId, requesterId, requesterRole)

    return this.prisma.project.update({
      where: { id: projectId },
      data: { name },
      select: PROJECT_SELECT,
    })
  }

  async deleteDeployment(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string, deploymentId: string) {
    const project = await this.assertAccess(projectId, requesterId, requesterRole)

    const deployment = await this.prisma.deployment.findFirst({ where: { id: deploymentId, projectId } })
    if (!deployment) throw new ProjectError('DEPLOYMENT_NOT_FOUND', 'Déploiement introuvable')

    if (deployment.status === 'building' || deployment.status === 'pending') {
      throw new ProjectError('DEPLOYMENT_BUILDING', 'Impossible de supprimer un déploiement en cours')
    }

    if (project.currentDeploymentId === deploymentId) {
      throw new ProjectError('DEPLOYMENT_IN_USE', 'Impossible de supprimer le déploiement actuellement en production')
    }

    // Supprimer l'image Docker versionnée si elle existe
    if (deployment.imageTag) {
      try {
        await this.docker.getImage(deployment.imageTag).remove({ force: true })
      } catch {
        // Image déjà supprimée ou inexistante — pas un problème
      }
    }

    await this.prisma.deployment.delete({ where: { id: deploymentId } })
  }

  async deleteProject(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string) {
    const project = await this.assertAccess(projectId, requesterId, requesterRole)

    // Supprimer le container (force: true gère tous les états)
    try {
      await this.docker.getContainer(`pontis-${project.slug}`).remove({ force: true })
    } catch {
      // Container inexistant — pas un problème
    }

    // Supprimer toutes les images versionnées du projet
    try {
      const images = await this.docker.listImages({
        filters: JSON.stringify({ reference: [`pontis-${project.slug}:*`] }),
      })
      await Promise.all(images.map((img) => this.docker.getImage(img.Id).remove({ force: true }).catch(() => null)))
    } catch {
      // Pas d'images — pas un problème
    }

    await removeProjectDir(project.slug).catch(() => null)
    await this.prisma.project.delete({ where: { id: projectId } })
  }

  // --- Méthodes de debug step-by-step ---

  private async getProjectContainer(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string) {
    const project = await this.assertAccess(projectId, requesterId, requesterRole)
    return { project, containerName: `pontis-${project.slug}`, imageTag: `pontis-${project.slug}:latest` }
  }

  async debugContainerStop(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string) {
    const { containerName } = await this.getProjectContainer(requesterId, requesterRole, projectId)
    const c = this.docker.getContainer(containerName)
    await c.stop()
    const info = await c.inspect()
    return { step: 'stop', containerName, id: info.Id.slice(0, 12), status: info.State.Status }
  }

  async debugContainerRemove(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string) {
    const { containerName } = await this.getProjectContainer(requesterId, requesterRole, projectId)
    const c = this.docker.getContainer(containerName)
    await c.remove()
    return { step: 'remove', containerName, removed: true }
  }

  async debugContainerCreate(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string) {
    const { project, containerName, imageTag } = await this.getProjectContainer(requesterId, requesterRole, projectId)
    const slug = project.slug
    const domain = project.domain ?? `${slug}.${process.env.APP_DOMAIN ?? 'app.ongoua.pro'}`
    const network = process.env.DOCKER_NETWORK ?? 'pontis_network'
    const container = await this.docker.createContainer({
      Image: imageTag,
      name: containerName,
      Labels: {
        'traefik.enable': 'true',
        [`traefik.http.routers.${slug}.rule`]: `Host(\`${domain}\`)`,
        [`traefik.http.routers.${slug}.entrypoints`]: 'websecure',
        [`traefik.http.routers.${slug}.tls`]: 'true',
        [`traefik.http.routers.${slug}.tls.certresolver`]: 'letsencrypt',
        [`traefik.http.services.${slug}.loadbalancer.server.port`]: '80',
      },
      HostConfig: { NetworkMode: network },
    })
    return { step: 'create', containerName, newId: container.id.slice(0, 12) }
  }

  async debugContainerStart(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string) {
    const { containerName } = await this.getProjectContainer(requesterId, requesterRole, projectId)
    const c = this.docker.getContainer(containerName)
    await c.start()
    const info = await c.inspect()
    return { step: 'start', containerName, id: info.Id.slice(0, 12), status: info.State.Status }
  }

  async debugContainerInspect(requesterId: string, requesterRole: 'developer' | 'admin', projectId: string) {
    const { containerName } = await this.getProjectContainer(requesterId, requesterRole, projectId)
    const info = await this.docker.getContainer(containerName).inspect()
    return { containerName, id: info.Id.slice(0, 12), status: info.State.Status, created: info.Created }
  }
}
