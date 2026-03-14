import { describe, it, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcrypt'
import { buildTestApp, API_PREFIX } from '../helpers/build'
import { makeMockPrisma } from '../helpers/prisma'
import { hashToken } from '../../lib/hash'
import type { FastifyInstance } from 'fastify'

const AUTH = `${API_PREFIX}/auth`

const mockUserBase = {
  id: 'user-uuid-1',
  email: 'test@example.com',
  gitlabId: null,
  gitlabToken: null,
  createdAt: new Date(),
}

// ------------------------------------------------------------------ register
describe('POST /auth/register', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: {
          findUnique: async () => null,
          create: async (args: any) => ({
            id: 'user-uuid-1',
            email: args.data.email,
            passwordHash: args.data.passwordHash,
            gitlabId: null,
            gitlabToken: null,
            createdAt: new Date(),
          }),
        },
      }),
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('success → 201, body has accessToken and userId, sets refresh_token cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${AUTH}/register`,
      payload: { email: 'new@example.com', password: 'password123' },
    })
    assert.equal(response.statusCode, 201)
    const body = response.json<{ accessToken: string; userId: string }>()
    assert.ok(typeof body.accessToken === 'string' && body.accessToken.length > 0)
    assert.ok(typeof body.userId === 'string' && body.userId.length > 0)
    const cookies = response.headers['set-cookie']
    assert.ok(cookies, 'set-cookie header should be present')
    const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : cookies
    assert.ok(cookieStr.includes('refresh_token='))
  })

  it('invalid email → 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${AUTH}/register`,
      payload: { email: 'not-an-email', password: 'password123' },
    })
    assert.equal(response.statusCode, 400)
  })

  it('password too short (< 8 chars) → 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${AUTH}/register`,
      payload: { email: 'short@example.com', password: 'abc' },
    })
    assert.equal(response.statusCode, 400)
  })
})

describe('POST /auth/register - duplicate email', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: {
          findUnique: async () => ({ ...mockUserBase, passwordHash: 'hash' }),
        },
      }),
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('duplicate email → 409', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${AUTH}/register`,
      payload: { email: 'test@example.com', password: 'password123' },
    })
    assert.equal(response.statusCode, 409)
    const body = response.json<{ error: string }>()
    assert.equal(body.error, 'Email already registered')
  })
})

// ------------------------------------------------------------------ login
describe('POST /auth/login', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash('password123', 1)
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: {
          findUnique: async () => ({ ...mockUserBase, passwordHash }),
        },
      }),
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('success → 200, body has accessToken and userId, sets cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${AUTH}/login`,
      payload: { email: 'test@example.com', password: 'password123' },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json<{ accessToken: string; userId: string }>()
    assert.ok(typeof body.accessToken === 'string' && body.accessToken.length > 0)
    assert.ok(typeof body.userId === 'string' && body.userId.length > 0)
    const cookies = response.headers['set-cookie']
    assert.ok(cookies, 'set-cookie header should be present')
    const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : cookies
    assert.ok(cookieStr.includes('refresh_token='))
  })

  it('wrong password → 401 { error: "Invalid credentials" }', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${AUTH}/login`,
      payload: { email: 'test@example.com', password: 'wrongpassword' },
    })
    assert.equal(response.statusCode, 401)
    const body = response.json<{ error: string }>()
    assert.equal(body.error, 'Invalid credentials')
  })
})

describe('POST /auth/login - unknown email', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({ user: { findUnique: async () => null } }),
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('unknown email → 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${AUTH}/login`,
      payload: { email: 'nobody@example.com', password: 'password123' },
    })
    assert.equal(response.statusCode, 401)
  })
})

// ------------------------------------------------------------------ refresh
describe('POST /auth/refresh', () => {
  let app: FastifyInstance
  let refreshToken: string
  let tokenRecord: { id: string; familyId: string; tokenHash: string; revokedAt: null }

  beforeAll(async () => {
    const familyId = randomUUID()

    // Build app first so we can call generateTokens to get the real token
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: { findUnique: async () => ({ ...mockUserBase, passwordHash: null }) },
        refreshToken: {
          findUnique: async () => tokenRecord ?? null,
          update: async () => ({}),
          create: async () => ({}),
        },
      }),
    })

    const result = app.generateTokens({ sub: mockUserBase.id, email: mockUserBase.email }, familyId)
    refreshToken = result.refreshToken
    tokenRecord = {
      id: 'rt-1',
      familyId,
      tokenHash: hashToken(refreshToken),
      revokedAt: null,
    }
  })

  afterAll(async () => {
    await app.close()
  })

  it('valid cookie → 200, body has accessToken', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${AUTH}/refresh`,
      headers: { cookie: `refresh_token=${refreshToken}` },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json<{ accessToken: string }>()
    assert.ok(typeof body.accessToken === 'string' && body.accessToken.length > 0)
  })

  it('no cookie → 401 { error: "No refresh token" }', async () => {
    const response = await app.inject({ method: 'POST', url: `${AUTH}/refresh` })
    assert.equal(response.statusCode, 401)
    const body = response.json<{ error: string }>()
    assert.equal(body.error, 'No refresh token')
  })

  it('invalid JWT → 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${AUTH}/refresh`,
      headers: { cookie: 'refresh_token=thisisnotavalidtoken' },
    })
    assert.equal(response.statusCode, 401)
  })

  it('valid JWT but not in DB → 401', async () => {
    // Build a separate app whose mock always returns null for findUnique
    const isolatedApp = await buildTestApp({
      prisma: makeMockPrisma({
        refreshToken: { findUnique: async () => null },
      }),
    })
    const { refreshToken: orphanToken } = isolatedApp.generateTokens(
      { sub: mockUserBase.id, email: mockUserBase.email },
      randomUUID()
    )
    const response = await isolatedApp.inject({
      method: 'POST',
      url: `${AUTH}/refresh`,
      headers: { cookie: `refresh_token=${orphanToken}` },
    })
    await isolatedApp.close()
    assert.equal(response.statusCode, 401)
  })

  it('reuse detected (token already revoked) → 401 + revokes family', async () => {
    const familyId = randomUUID()
    let familyRevoked = false

    const isolatedApp = await buildTestApp({
      prisma: makeMockPrisma({
        refreshToken: {
          findUnique: async () => ({
            id: 'rt-old',
            familyId,
            tokenHash: 'whatever',
            revokedAt: new Date(), // already revoked
          }),
          updateMany: async () => {
            familyRevoked = true
            return { count: 1 }
          },
        },
      }),
    })
    const { refreshToken: revokedToken } = isolatedApp.generateTokens(
      { sub: mockUserBase.id, email: mockUserBase.email },
      familyId
    )
    const response = await isolatedApp.inject({
      method: 'POST',
      url: `${AUTH}/refresh`,
      headers: { cookie: `refresh_token=${revokedToken}` },
    })
    await isolatedApp.close()
    assert.equal(response.statusCode, 401)
    const body = response.json<{ error: string }>()
    assert.equal(body.error, 'Refresh token reuse detected')
    assert.ok(familyRevoked, 'entire family should be revoked')
  })
})

// ------------------------------------------------------------------ logout
describe('GET /auth/logout', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        refreshToken: { updateMany: async () => ({ count: 1 }) },
      }),
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('→ 200 { ok: true }, clears refresh_token cookie', async () => {
    const response = await app.inject({ method: 'GET', url: `${AUTH}/logout` })
    assert.equal(response.statusCode, 200)
    const body = response.json<{ ok: boolean }>()
    assert.equal(body.ok, true)
    const cookies = response.headers['set-cookie']
    assert.ok(cookies, 'set-cookie header should be present')
    const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : cookies
    assert.ok(
      cookieStr.includes('refresh_token=') || cookieStr.toLowerCase().includes('max-age=0') || cookieStr.toLowerCase().includes('expires='),
      'cookie should be cleared'
    )
  })
})

// ------------------------------------------------------------------ gitlab
describe('GET /auth/gitlab', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    delete process.env.GITLAB_URL
    delete process.env.GITLAB_CLIENT_ID
    delete process.env.GITLAB_CALLBACK_URL
    app = await buildTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('without env vars → 503', async () => {
    const response = await app.inject({ method: 'GET', url: `${AUTH}/gitlab` })
    assert.equal(response.statusCode, 503)
  })
})
