import { describe, it, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { buildTestApp, API_PREFIX } from '../helpers/build'
import { makeMockPrisma } from '../helpers/prisma'
import type { FastifyInstance } from 'fastify'

const USERS = `${API_PREFIX}/users`

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

function makeUserListEntry(overrides: Record<string, any> = {}) {
  return {
    id: 'user-uuid',
    email: 'user@example.com',
    name: 'User',
    role: 'developer' as const,
    blocked: false,
    createdAt: new Date(),
    gitlabId: null,
    passwordHash: 'hash',
    _count: { projects: 0 },
    ...overrides,
  }
}

// ------------------------------------------------------------------ GET /users
describe('GET /users - unauthenticated', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('no token → 401', async () => {
    const response = await app.inject({ method: 'GET', url: USERS })
    assert.equal(response.statusCode, 401)
  })
})

describe('GET /users - developer token', () => {
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

  it('developer token → 403 (no users:list permission)', async () => {
    const { accessToken } = app.generateTokens({
      sub: developerUserBase.id,
      email: developerUserBase.email,
      role: 'developer',
    })
    const response = await app.inject({
      method: 'GET',
      url: USERS,
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert.equal(response.statusCode, 403)
  })
})

describe('GET /users - admin token', () => {
  let app: FastifyInstance
  let adminToken: string

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: {
          findUnique: async () => ({ ...adminUserBase, passwordHash: 'hash' }),
          findMany: async () => [
            makeUserListEntry({ id: 'user-1', email: 'alice@example.com' }),
            makeUserListEntry({ id: 'user-2', email: 'bob@example.com', gitlabId: 99, passwordHash: null }),
          ],
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

  it('admin token → 200, returns paginated user list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: USERS,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json<{ data: any[]; total: number; page: number; limit: number }>()
    assert.equal(body.total, 2)
    assert.equal(body.data.length, 2)
    assert.equal(body.page, 1)
    assert.ok(typeof body.limit === 'number')
  })

  it('maps gitlabId to authMethod=gitlab', async () => {
    const response = await app.inject({
      method: 'GET',
      url: USERS,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    const body = response.json<{ data: any[] }>()
    const gitlabUser = body.data.find((u: any) => u.id === 'user-2')
    const passwordUser = body.data.find((u: any) => u.id === 'user-1')
    assert.equal(gitlabUser?.authMethod, 'gitlab')
    assert.equal(passwordUser?.authMethod, 'password')
  })

  it('does not expose passwordHash in response', async () => {
    const response = await app.inject({
      method: 'GET',
      url: USERS,
      headers: { authorization: `Bearer ${adminToken}` },
    })
    const body = response.json<{ data: any[] }>()
    for (const user of body.data) {
      assert.ok(!('passwordHash' in user), 'passwordHash should not be exposed')
      assert.ok(!('gitlabId' in user), 'gitlabId should not be exposed directly')
    }
  })
})

// ------------------------------------------------------------------ PATCH /users/:id/role
describe('PATCH /users/:id/role', () => {
  let app: FastifyInstance
  let adminToken: string

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: {
          findUnique: async () => ({ ...adminUserBase, passwordHash: 'hash' }),
          update: async (args: any) => ({ id: args.where.id, role: args.data.role }),
          count: async () => 2, // there are 2 admins, safe to downgrade
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

  it('cannot change own role → 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `${USERS}/${adminUserBase.id}/role`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: 'developer' },
    })
    assert.equal(response.statusCode, 400)
  })

  it('invalid role value → 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `${USERS}/other-user-id/role`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: 'superadmin' },
    })
    assert.equal(response.statusCode, 400)
  })

  it('successfully changes another user role → 200', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `${USERS}/other-user-id/role`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: 'developer' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json<{ id: string; role: string }>()
    assert.equal(body.role, 'developer')
  })
})

describe('PATCH /users/:id/role - last admin guard', () => {
  let app: FastifyInstance
  let adminToken: string

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: {
          findUnique: async () => ({ ...adminUserBase, passwordHash: 'hash' }),
          count: async () => 1, // only 1 admin left
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

  it('downgrading last admin → 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `${USERS}/other-user-id/role`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: 'developer' },
    })
    assert.equal(response.statusCode, 400)
    const body = response.json<{ error: string }>()
    assert.ok(body.error.includes('administrateur'))
  })
})

// ------------------------------------------------------------------ PATCH /users/:id/block
describe('PATCH /users/:id/block', () => {
  let app: FastifyInstance
  let adminToken: string

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: {
          findUnique: async () => ({ ...adminUserBase, passwordHash: 'hash' }),
          update: async (args: any) => ({ id: args.where.id, ...args.data }),
        },
        refreshToken: {
          updateMany: async () => ({ count: 1 }),
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

  it('cannot block self → 400', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `${USERS}/${adminUserBase.id}/block`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { blocked: true },
    })
    assert.equal(response.statusCode, 400)
  })

  it('block another user → 200 { id, blocked: true }', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `${USERS}/target-user-id/block`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { blocked: true },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json<{ id: string; blocked: boolean }>()
    assert.equal(body.id, 'target-user-id')
    assert.equal(body.blocked, true)
  })

  it('unblock a user → 200 { id, blocked: false }', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `${USERS}/target-user-id/block`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { blocked: false },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json<{ id: string; blocked: boolean }>()
    assert.equal(body.blocked, false)
  })
})
