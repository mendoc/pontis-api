import { FastifyPluginAsync } from 'fastify'
import { authenticate } from '../../middleware/authenticate'
import { requirePermission } from '../../middleware/requirePermission'

const usersRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /users — liste paginée des utilisateurs
  fastify.get('/', { preHandler: [authenticate, requirePermission('users:list')] }, async (request, reply) => {
    const {
      page = '1',
      limit = '20',
      search = '',
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = request.query as Record<string, string>

    const pageNum = Math.max(1, parseInt(page, 10))
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)))
    const skip = (pageNum - 1) * limitNum

    const where = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' as const } },
            { name: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}

    const validSortBy = ['email', 'name', 'role', 'createdAt', 'projects'].includes(sortBy) ? sortBy : 'createdAt'
    const validSortOrder: 'asc' | 'desc' = sortOrder === 'asc' ? 'asc' : 'desc'

    const orderBy = validSortBy === 'projects'
      ? { projects: { _count: validSortOrder } }
      : { [validSortBy]: validSortOrder }

    const [users, total] = await Promise.all([
      fastify.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          blocked: true,
          createdAt: true,
          gitlabId: true,
          passwordHash: true,
          _count: { select: { projects: true } },
        },
        orderBy,
        skip,
        take: limitNum,
      }),
      fastify.prisma.user.count({ where }),
    ])

    const data = users.map(({ gitlabId, passwordHash, ...u }) => ({
      ...u,
      authMethod: gitlabId ? 'gitlab' : 'password',
    }))

    return reply.send({ data, total, page: pageNum, limit: limitNum })
  })

  // PATCH /users/:id/role — changer le rôle d'un utilisateur
  fastify.patch('/:id/role', { preHandler: [authenticate, requirePermission('users:update')] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { role } = request.body as { role: string }

    if (id === request.user.sub) {
      return reply.status(400).send({ error: 'Cannot change your own role' })
    }

    if (role !== 'admin' && role !== 'developer') {
      return reply.status(400).send({ error: 'Invalid role' })
    }

    const user = await fastify.prisma.user.update({
      where: { id },
      data: { role },
      select: { id: true, role: true },
    })

    return reply.send(user)
  })

  // PATCH /users/:id/block — bloquer ou débloquer un utilisateur
  fastify.patch('/:id/block', { preHandler: [authenticate, requirePermission('users:update')] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { blocked } = request.body as { blocked: boolean }

    if (id === request.user.sub) {
      return reply.status(400).send({ error: 'Cannot block yourself' })
    }

    if (blocked) {
      await fastify.prisma.$transaction([
        fastify.prisma.user.update({ where: { id }, data: { blocked: true } }),
        fastify.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
      ])
    } else {
      await fastify.prisma.user.update({ where: { id }, data: { blocked: false } })
    }

    return reply.send({ id, blocked })
  })
}

export default usersRoutes
