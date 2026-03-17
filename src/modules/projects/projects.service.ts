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

  async listProjects(userId: string) {
    return this.prisma.project.findMany({
      where: { userId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, slug: true, status: true, domain: true },
    })
  }

  async getProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { id: true, name: true, slug: true, status: true, domain: true },
    })

    if (!project) {
      throw new ProjectError('PROJECT_NOT_FOUND', 'Projet introuvable')
    }

    return project
  }
}
