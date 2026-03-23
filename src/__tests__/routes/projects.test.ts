import { describe, it, beforeAll, afterAll, vi } from 'vitest'
import assert from 'node:assert/strict'
import { buildTestApp, API_PREFIX } from '../helpers/build'
import { makeMockPrisma } from '../helpers/prisma'
import type { FastifyInstance } from 'fastify'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// Mock builders so no real Docker calls are made
vi.mock('../../lib/static-builder', () => ({
  buildAndRunStaticProject: vi.fn().mockResolvedValue({ domain: 'test-proj.app.example.com', logs: 'static build ok' }),
  NGINX_HEALTHCHECK: { Test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:80/ || exit 1'], Interval: 30_000_000_000, Timeout: 5_000_000_000, Retries: 3, StartPeriod: 10_000_000_000 },
}))
vi.mock('../../lib/docker-builder', () => ({
  buildAndRunDockerProject: vi.fn().mockResolvedValue({ domain: 'my-laravel.app.example.com', logs: 'docker build ok' }),
  recreateDockerContainer: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/crypto', () => ({
  encrypt: vi.fn((v: string) => `mock-encrypted:${v}`),
  decrypt: vi.fn((v: string) => v.replace('mock-encrypted:', '')),
}))

const PROJECTS = `${API_PREFIX}/projects`

const devUserBase = {
  id: 'dev-uuid-1',
  email: 'dev@example.com',
  name: 'Dev User',
  role: 'developer' as const,
  blocked: false,
  gitlabId: null,
  gitlabToken: null,
  createdAt: new Date(),
}

const projectBase = {
  id: 'proj-uuid-1',
  userId: devUserBase.id,
  name: 'My Project',
  slug: 'my-project',
  type: 'static' as const,
  status: 'running',
  domain: 'my-project.app.example.com',
  createdAt: new Date(),
  restartedAt: null,
  currentDeploymentId: 'dep-uuid-1',
  internalPort: 8000,
  healthcheckPath: '/health',
}

// ------------------------------------------------------------------ GET /projects (auth guards)
describe('GET /projects - unauthenticated', () => {
  let app: FastifyInstance

  beforeAll(async () => { app = await buildTestApp() })
  afterAll(async () => { await app.close() })

  it('no token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: PROJECTS })
    assert.equal(res.statusCode, 401)
  })
})

describe('GET /projects - developer token', () => {
  let app: FastifyInstance
  let devToken: string

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: { findUnique: async () => ({ ...devUserBase, passwordHash: 'hash' }) },
        project: {
          findMany: async () => [],
          count: async () => 0,
        },
      }),
    })
    devToken = app.generateTokens({ sub: devUserBase.id, email: devUserBase.email, role: 'developer' }).accessToken
  })
  afterAll(async () => { await app.close() })

  it('returns 200 with empty paginated list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: PROJECTS,
      headers: { authorization: `Bearer ${devToken}` },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json<{ data: any[]; total: number; page: number; limit: number }>()
    assert.equal(body.total, 0)
    assert.equal(body.data.length, 0)
    assert.equal(body.page, 1)
  })
})

// ------------------------------------------------------------------ GET /projects/:id
describe('GET /projects/:id', () => {
  let app: FastifyInstance
  let devToken: string

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: { findUnique: async () => ({ ...devUserBase, passwordHash: 'hash' }) },
        project: {
          findUnique: async () => ({ ...projectBase }),
        },
      }),
    })
    devToken = app.generateTokens({ sub: devUserBase.id, email: devUserBase.email, role: 'developer' }).accessToken
  })
  afterAll(async () => { await app.close() })

  it('returns 200 with project details', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PROJECTS}/${projectBase.id}`,
      headers: { authorization: `Bearer ${devToken}` },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json<any>()
    assert.equal(body.id, projectBase.id)
    assert.equal(body.slug, projectBase.slug)
  })

  it('returns 404 when project not found', async () => {
    const appNotFound = await buildTestApp({
      prisma: makeMockPrisma({
        user: { findUnique: async () => ({ ...devUserBase, passwordHash: 'hash' }) },
        project: { findUnique: async () => null },
      }),
    })
    const token = appNotFound.generateTokens({ sub: devUserBase.id, email: devUserBase.email, role: 'developer' }).accessToken
    const res = await appNotFound.inject({
      method: 'GET',
      url: `${PROJECTS}/nonexistent-id`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 404)
    await appNotFound.close()
  })
})

// ------------------------------------------------------------------ POST /upload/finalize (static)
describe('POST /upload/finalize - static project', () => {
  let app: FastifyInstance
  let devToken: string
  let uploadId: string

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: { findUnique: async () => ({ ...devUserBase, passwordHash: 'hash' }) },
        project: {
          findUnique: async () => null, // slug not taken
          create: async (args: any) => ({ ...projectBase, ...args.data, id: 'new-proj-uuid' }),
          update: async (args: any) => ({ ...projectBase, ...args.data }),
        },
        deployment: {
          create: async () => ({ id: 'dep-new', projectId: 'new-proj-uuid', status: 'building' }),
          update: async () => ({}),
        },
        envVar: {
          findMany: async () => [],
        },
      }),
    })
    devToken = app.generateTokens({ sub: devUserBase.id, email: devUserBase.email, role: 'developer' }).accessToken

    // Prepare upload chunks in tmpdir
    uploadId = randomUUID()
    const uploadDir = join(tmpdir(), 'pontis-uploads', uploadId)
    await mkdir(uploadDir, { recursive: true })
    // Write a minimal ZIP buffer (fake content for test — builder is mocked)
    await writeFile(join(uploadDir, '0'), Buffer.from('PK\x03\x04fake-zip-content'))
  })

  afterAll(async () => {
    await rm(join(tmpdir(), 'pontis-uploads', uploadId), { recursive: true, force: true })
    await app.close()
  })

  it('missing fields → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PROJECTS}/upload/finalize`,
      headers: { authorization: `Bearer ${devToken}`, 'content-type': 'application/json' },
      payload: { name: 'My Project' }, // missing uploadId and totalChunks
    })
    assert.equal(res.statusCode, 400)
  })

  it('creates a static project → 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PROJECTS}/upload/finalize`,
      headers: { authorization: `Bearer ${devToken}`, 'content-type': 'application/json' },
      payload: { name: 'My Project', uploadId, totalChunks: 1, type: 'static' },
    })
    assert.equal(res.statusCode, 201)
    const body = res.json<any>()
    assert.ok(body.id)
    assert.ok(body.slug)
    assert.ok(body.deploymentId)
    assert.equal(body.type, 'static')
  })
})

// ------------------------------------------------------------------ POST /upload/finalize (docker)
describe('POST /upload/finalize - docker project', () => {
  let app: FastifyInstance
  let devToken: string
  let uploadId: string

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: { findUnique: async () => ({ ...devUserBase, passwordHash: 'hash' }) },
        project: {
          findUnique: async () => null,
          create: async (args: any) => ({
            ...projectBase,
            ...args.data,
            id: 'docker-proj-uuid',
            type: 'docker',
            internalPort: 8000,
            healthcheckPath: '/health',
          }),
          update: async (args: any) => ({ ...projectBase, ...args.data }),
        },
        deployment: {
          create: async () => ({ id: 'dep-docker', projectId: 'docker-proj-uuid', status: 'building' }),
          update: async () => ({}),
        },
        envVar: {
          createMany: async () => ({ count: 2 }),
          findMany: async () => [
            { id: 'ev-1', key: 'APP_KEY', valueEncrypted: 'mock-encrypted:secret123' },
            { id: 'ev-2', key: 'DB_HOST', valueEncrypted: 'mock-encrypted:localhost' },
          ],
        },
      }),
    })
    devToken = app.generateTokens({ sub: devUserBase.id, email: devUserBase.email, role: 'developer' }).accessToken

    uploadId = randomUUID()
    const uploadDir = join(tmpdir(), 'pontis-uploads', uploadId)
    await mkdir(uploadDir, { recursive: true })
    await writeFile(join(uploadDir, '0'), Buffer.from('PK\x03\x04fake-zip-content'))
    await writeFile(join(uploadDir, '1'), Buffer.from('more-content'))
  })

  afterAll(async () => {
    await rm(join(tmpdir(), 'pontis-uploads', uploadId), { recursive: true, force: true })
    await app.close()
  })

  it('creates a docker project with envVars → 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PROJECTS}/upload/finalize`,
      headers: { authorization: `Bearer ${devToken}`, 'content-type': 'application/json' },
      payload: {
        name: 'My Laravel App',
        uploadId,
        totalChunks: 2,
        type: 'docker',
        internalPort: 8000,
        healthcheckPath: '/health',
        envVars: [
          { key: 'APP_KEY', value: 'secret123' },
          { key: 'DB_HOST', value: 'localhost' },
        ],
      },
    })
    assert.equal(res.statusCode, 201)
    const body = res.json<any>()
    assert.equal(body.type, 'docker')
    assert.ok(body.deploymentId)
  })

  it('invalid project name → 400 (caught before file read via missing totalChunks guard)', async () => {
    // Provide an invalid name with a fresh upload dir so we can exercise schema validation
    const freshUploadId = randomUUID()
    const freshDir = join(tmpdir(), 'pontis-uploads', freshUploadId)
    await mkdir(freshDir, { recursive: true })
    await writeFile(join(freshDir, '0'), Buffer.from('fake'))
    try {
      const res = await app.inject({
        method: 'POST',
        url: `${PROJECTS}/upload/finalize`,
        headers: { authorization: `Bearer ${devToken}`, 'content-type': 'application/json' },
        payload: { name: '!!!invalid!!!', uploadId: freshUploadId, totalChunks: 1, type: 'docker' },
      })
      assert.equal(res.statusCode, 400)
    } finally {
      await rm(freshDir, { recursive: true, force: true })
    }
  })

  it('invalid internalPort → 400', async () => {
    const freshUploadId = randomUUID()
    const freshDir = join(tmpdir(), 'pontis-uploads', freshUploadId)
    await mkdir(freshDir, { recursive: true })
    await writeFile(join(freshDir, '0'), Buffer.from('fake'))
    try {
      const res = await app.inject({
        method: 'POST',
        url: `${PROJECTS}/upload/finalize`,
        headers: { authorization: `Bearer ${devToken}`, 'content-type': 'application/json' },
        payload: { name: 'Valid Name', uploadId: freshUploadId, totalChunks: 1, type: 'docker', internalPort: 99999 },
      })
      assert.equal(res.statusCode, 400)
    } finally {
      await rm(freshDir, { recursive: true, force: true })
    }
  })
})

// ------------------------------------------------------------------ GET /projects/:id/env-vars
describe('GET /projects/:id/env-vars', () => {
  let app: FastifyInstance
  let devToken: string

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: { findUnique: async () => ({ ...devUserBase, passwordHash: 'hash' }) },
        project: {
          findUnique: async () => ({ ...projectBase }),
        },
        envVar: {
          findMany: async () => [
            { id: 'ev-1', key: 'APP_KEY' },
            { id: 'ev-2', key: 'DB_HOST' },
          ],
        },
      }),
    })
    devToken = app.generateTokens({ sub: devUserBase.id, email: devUserBase.email, role: 'developer' }).accessToken
  })
  afterAll(async () => { await app.close() })

  it('returns 200 with key list (no values exposed)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PROJECTS}/${projectBase.id}/env-vars`,
      headers: { authorization: `Bearer ${devToken}` },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json<any[]>()
    assert.equal(body.length, 2)
    assert.ok(body.every((v: any) => 'key' in v), 'each entry should have a key')
    assert.ok(body.every((v: any) => !('valueEncrypted' in v)), 'valueEncrypted must not be exposed')
    assert.ok(body.every((v: any) => !('value' in v)), 'plaintext value must not be exposed')
  })

  it('no token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: `${PROJECTS}/${projectBase.id}/env-vars` })
    assert.equal(res.statusCode, 401)
  })
})

// ------------------------------------------------------------------ POST /projects/:id/env-vars
describe('POST /projects/:id/env-vars', () => {
  let app: FastifyInstance
  let devToken: string

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: { findUnique: async () => ({ ...devUserBase, passwordHash: 'hash' }) },
        project: { findUnique: async () => ({ ...projectBase }) },
        envVar: {
          findFirst: async () => null, // not existing → create
          create: async (args: any) => ({ id: 'ev-new', key: args.data.key }),
        },
      }),
    })
    devToken = app.generateTokens({ sub: devUserBase.id, email: devUserBase.email, role: 'developer' }).accessToken
  })
  afterAll(async () => { await app.close() })

  it('creates a new env var → 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PROJECTS}/${projectBase.id}/env-vars`,
      headers: { authorization: `Bearer ${devToken}`, 'content-type': 'application/json' },
      payload: { key: 'APP_KEY', value: 'secret123' },
    })
    assert.equal(res.statusCode, 201)
    const body = res.json<any>()
    assert.equal(body.key, 'APP_KEY')
    assert.ok(!('value' in body), 'plaintext value must not be returned')
    assert.ok(!('valueEncrypted' in body), 'encrypted value must not be returned')
  })

  it('updates existing env var → 201', async () => {
    const appWithExisting = await buildTestApp({
      prisma: makeMockPrisma({
        user: { findUnique: async () => ({ ...devUserBase, passwordHash: 'hash' }) },
        project: { findUnique: async () => ({ ...projectBase }) },
        envVar: {
          findFirst: async () => ({ id: 'ev-existing', key: 'APP_KEY', valueEncrypted: 'old' }),
          update: async () => ({ id: 'ev-existing', key: 'APP_KEY' }),
        },
      }),
    })
    const token = appWithExisting.generateTokens({ sub: devUserBase.id, email: devUserBase.email, role: 'developer' }).accessToken

    const res = await appWithExisting.inject({
      method: 'POST',
      url: `${PROJECTS}/${projectBase.id}/env-vars`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { key: 'APP_KEY', value: 'new-secret' },
    })
    assert.equal(res.statusCode, 201)
    await appWithExisting.close()
  })

  it('invalid key format → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PROJECTS}/${projectBase.id}/env-vars`,
      headers: { authorization: `Bearer ${devToken}`, 'content-type': 'application/json' },
      payload: { key: 'invalid key with spaces', value: 'v' },
    })
    assert.equal(res.statusCode, 400)
  })

  it('missing key → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PROJECTS}/${projectBase.id}/env-vars`,
      headers: { authorization: `Bearer ${devToken}`, 'content-type': 'application/json' },
      payload: { value: 'v' },
    })
    assert.equal(res.statusCode, 400)
  })

  it('no token → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PROJECTS}/${projectBase.id}/env-vars`,
      payload: { key: 'K', value: 'v' },
    })
    assert.equal(res.statusCode, 401)
  })
})

// ------------------------------------------------------------------ DELETE /projects/:id/env-vars/:key
describe('DELETE /projects/:id/env-vars/:key', () => {
  let app: FastifyInstance
  let devToken: string

  beforeAll(async () => {
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: { findUnique: async () => ({ ...devUserBase, passwordHash: 'hash' }) },
        project: { findUnique: async () => ({ ...projectBase }) },
        envVar: {
          findFirst: async () => ({ id: 'ev-1', key: 'APP_KEY', valueEncrypted: 'enc' }),
          delete: async () => ({}),
        },
      }),
    })
    devToken = app.generateTokens({ sub: devUserBase.id, email: devUserBase.email, role: 'developer' }).accessToken
  })
  afterAll(async () => { await app.close() })

  it('deletes existing env var → 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `${PROJECTS}/${projectBase.id}/env-vars/APP_KEY`,
      headers: { authorization: `Bearer ${devToken}` },
    })
    assert.equal(res.statusCode, 204)
  })

  it('env var not found → 404', async () => {
    const appNotFound = await buildTestApp({
      prisma: makeMockPrisma({
        user: { findUnique: async () => ({ ...devUserBase, passwordHash: 'hash' }) },
        project: { findUnique: async () => ({ ...projectBase }) },
        envVar: { findFirst: async () => null },
      }),
    })
    const token = appNotFound.generateTokens({ sub: devUserBase.id, email: devUserBase.email, role: 'developer' }).accessToken
    const res = await appNotFound.inject({
      method: 'DELETE',
      url: `${PROJECTS}/${projectBase.id}/env-vars/NONEXISTENT`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 404)
    await appNotFound.close()
  })

  it('access denied to another user project → 403', async () => {
    const appOtherUser = await buildTestApp({
      prisma: makeMockPrisma({
        user: { findUnique: async () => ({ ...devUserBase, passwordHash: 'hash' }) },
        project: {
          findUnique: async () => ({ ...projectBase, userId: 'other-user-id' }), // different owner
        },
        envVar: { findFirst: async () => ({ id: 'ev-1', key: 'K', valueEncrypted: 'enc' }) },
      }),
    })
    const token = appOtherUser.generateTokens({ sub: devUserBase.id, email: devUserBase.email, role: 'developer' }).accessToken
    const res = await appOtherUser.inject({
      method: 'DELETE',
      url: `${PROJECTS}/${projectBase.id}/env-vars/K`,
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.statusCode, 403)
    await appOtherUser.close()
  })

  it('no token → 401', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `${PROJECTS}/${projectBase.id}/env-vars/APP_KEY`,
    })
    assert.equal(res.statusCode, 401)
  })
})
