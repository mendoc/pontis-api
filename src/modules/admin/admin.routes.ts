import { FastifyPluginAsync } from 'fastify'
import { authenticate } from '../../middleware/authenticate'
import { requirePermission } from '../../middleware/requirePermission'

const adminRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /admin/projects — liste paginée de tous les projets (toutes permissions)
  fastify.get('/projects', { preHandler: [authenticate, requirePermission('users:list')] }, async (request, reply) => {
    const {
      page = '1',
      limit = '20',
      search = '',
      sortBy = 'createdAt',
      sortOrder = 'desc',
      status = '',
    } = request.query as Record<string, string>

    const pageNum = Math.max(1, parseInt(page, 10))
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)))
    const skip = (pageNum - 1) * limitNum

    const SORTABLE = ['name', 'slug', 'status', 'type', 'createdAt']
    const validSortBy = SORTABLE.includes(sortBy) ? sortBy : 'createdAt'
    const validSortOrder = sortOrder === 'asc' ? 'asc' : ('desc' as const)

    const where = {
      ...(status ? { status } : {}),
      ...(search ? {
        OR: [
          { name:   { contains: search, mode: 'insensitive' as const } },
          { slug:   { contains: search, mode: 'insensitive' as const } },
          { domain: { contains: search, mode: 'insensitive' as const } },
          { user:   { email: { contains: search, mode: 'insensitive' as const } } },
          { user:   { name:  { contains: search, mode: 'insensitive' as const } } },
        ],
      } : {}),
    }

    const [rawData, total] = await fastify.prisma.$transaction([
      fastify.prisma.project.findMany({
        where,
        orderBy: { [validSortBy]: validSortOrder },
        select: {
          id: true,
          name: true,
          slug: true,
          type: true,
          status: true,
          domain: true,
          createdAt: true,
          user: { select: { id: true, email: true, name: true } },
          deployments: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
        },
        skip,
        take: limitNum,
      }),
      fastify.prisma.project.count({ where }),
    ])

    const data = rawData.map(({ deployments, ...p }) => ({
      ...p,
      lastDeployedAt: deployments[0]?.createdAt?.toISOString() ?? null,
    }))

    return reply.send({ data, total, page: pageNum, limit: limitNum })
  })
}

export default adminRoutes
