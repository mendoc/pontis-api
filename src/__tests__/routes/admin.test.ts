import { describe, it, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { buildTestApp, API_PREFIX } from '../helpers/build'
import { makeMockPrisma } from '../helpers/prisma'
import type { FastifyInstance } from 'fastify'

const ADMIN = `${API_PREFIX}/admin`

const adminUserBase = {
  id: 'admin-uuid-1',
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'admin' as const,
  blocked: false,
  gitlabId: null,
  gitlabToken: null,
  createdAt: new Date(),
}

const developerUserBase = {
  id: 'dev-uuid-1',
  email: 'dev@example.com',
  name: 'Dev User',
  role: 'developer' as const,
  blocked: false,
  gitlabId: null,
  gitlabToken: null,
  createdAt: new Date(),
}

function makeMockProject(overrides: Record<string, any> = {}) {
  return {
    id: 'proj-1',
    name: 'My Site',
    slug: 'my-site',
    type: 'static',
    status: 'running',
    domain: 'my-site.app.example.com',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    user: { id: 'user-1', email: 'owner@example.com', name: 'Owner' },
    deployments: [{ createdAt: new Date('2025-06-01T00:00:00Z') }],
    ...overrides,
  }
}

// ------------------------------------------------------------------ GET /admin/projects - unauthenticated
describe('GET /admin/projects - unauthenticated', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('no token → 401', async () => {
    const response = await app.inject({ method: 'GET', url: `${ADMIN}/projects` })
    assert.equal(response.statusCode, 401)
  })
})

// ------------------------------------------------------------------ GET /admin/projects - developer (no permission)
describe('GET /admin/projects - developer token', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: { findUnique: async () => ({ ...developerUserBase, passwordHash: 'hash' }) },
      }),
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('developer token → 403', async () => {
    const { accessToken } = app.generateTokens({
      sub: developerUserBase.id,
      email: developerUserBase.email,
      role: 'developer',
    })
    const response = await app.inject({
      method: 'GET',
      url: `${ADMIN}/projects`,
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert.equal(response.statusCode, 403)
  })
})

// ------------------------------------------------------------------ GET /admin/projects - admin
describe('GET /admin/projects - admin token', () => {
  let app: FastifyInstance
  let adminToken: string

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: {
          findUnique: async () => ({ ...adminUserBase, passwordHash: 'hash' }),
        },
        project: {
          findMany: async () => [makeMockProject(), makeMockProject({ id: 'proj-2', slug: 'other-site', deployments: [] })],
          count: async () => 2,
        },
      }),
    })
    const tokens = app.generateTokens({
      sub: adminUserBase.id,
      email: adminUserBase.email,
      role: 'admin',
    })
    adminToken = tokens.accessToken
  })

  afterAll(async () => {
    await app.close()
  })

  it('admin token → 200, returns paginated project list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${ADMIN}/projects`,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json<{ data: any[]; total: number; page: number; limit: number }>()
    assert.equal(body.total, 2)
    assert.equal(body.data.length, 2)
    assert.equal(body.page, 1)
    assert.ok(typeof body.limit === 'number')
  })

  it('includes owner info in each project', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${ADMIN}/projects`,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    const body = response.json<{ data: any[] }>()
    const project = body.data[0]
    assert.ok(project.user, 'project should have user field')
    assert.ok(project.user.email, 'user should have email')
  })

  it('maps lastDeployedAt from deployments', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${ADMIN}/projects`,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    const body = response.json<{ data: any[] }>()
    const withDeploy = body.data.find((p: any) => p.id === 'proj-1')
    const withoutDeploy = body.data.find((p: any) => p.id === 'proj-2')
    assert.ok(withDeploy?.lastDeployedAt, 'should have lastDeployedAt when deployment exists')
    assert.equal(withoutDeploy?.lastDeployedAt, null, 'should be null when no deployments')
  })

  it('does not expose raw deployments array', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${ADMIN}/projects`,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    const body = response.json<{ data: any[] }>()
    for (const project of body.data) {
      assert.ok(!('deployments' in project), 'raw deployments array should not be exposed')
    }
  })

  it('pagination params are respected', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${ADMIN}/projects?page=2&limit=10`,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json<{ page: number; limit: number }>()
    assert.equal(body.page, 2)
    assert.equal(body.limit, 10)
  })
})
