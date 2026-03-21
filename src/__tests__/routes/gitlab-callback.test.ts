import { describe, it, beforeAll, afterAll, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'
import type { Dispatcher } from 'undici'
import { buildTestApp, API_PREFIX } from '../helpers/build'
import { makeMockPrisma } from '../helpers/prisma'
import type { FastifyInstance } from 'fastify'

const AUTH = `${API_PREFIX}/auth`

const GITLAB_URL = 'http://gitlab.test'
const FRONTEND_URL = 'http://localhost:3000'
const GITLAB_ENV = {
  GITLAB_URL,
  GITLAB_CLIENT_ID: 'test-client-id',
  GITLAB_CLIENT_SECRET: 'test-client-secret',
  GITLAB_CALLBACK_URL: 'http://localhost:3001/auth/gitlab/callback',
  FRONTEND_URL,
}

const mockGitlabUser = { id: 42, email: 'gitlab@example.com', name: 'GitLab User' }

// ------------------------------------------------------------------ without env vars
describe('GET /auth/gitlab/callback - without env vars', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    delete process.env.GITLAB_URL
    delete process.env.GITLAB_CLIENT_ID
    delete process.env.GITLAB_CLIENT_SECRET
    delete process.env.GITLAB_CALLBACK_URL
    app = await buildTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('→ redirect to login?error=gitlab_failed when GitLab env vars not configured', async () => {
    const response = await app.inject({ method: 'GET', url: `${AUTH}/gitlab/callback?code=abc` })
    assert.equal(response.statusCode, 302)
    assert.ok(response.headers.location?.includes('error=gitlab_failed'))
  })
})

// ------------------------------------------------------------------ with env vars
describe('GET /auth/gitlab/callback - with env vars', () => {
  let app: FastifyInstance
  let originalDispatcher: Dispatcher

  beforeAll(async () => {
    Object.assign(process.env, GITLAB_ENV)
    app = await buildTestApp({
      prisma: makeMockPrisma({
        user: {
          upsert: async (args: any) => ({
            id: 'user-uuid-gitlab',
            email: args.create.email,
            name: args.create.name ?? null,
            gitlabId: args.create.gitlabId,
            gitlabToken: args.create.gitlabToken,
            passwordHash: null,
            role: 'developer',
            createdAt: new Date(),
          }),
        },
      }),
    })
    originalDispatcher = getGlobalDispatcher()
  })

  afterAll(async () => {
    await app.close()
    setGlobalDispatcher(originalDispatcher)
    for (const key of Object.keys(GITLAB_ENV)) delete process.env[key]
  })

  afterEach(() => {
    setGlobalDispatcher(originalDispatcher)
  })

  it('missing code query param → redirect to login?error=gitlab_denied', async () => {
    const response = await app.inject({ method: 'GET', url: `${AUTH}/gitlab/callback` })
    assert.equal(response.statusCode, 302)
    assert.ok(response.headers.location?.includes('error=gitlab_denied'))
  })

  it('token exchange fails → redirect to login?error=gitlab_failed', async () => {
    const agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
    agent.get(GITLAB_URL).intercept({ path: '/oauth/token', method: 'POST' }).reply(400, { error: 'bad_code' })

    const response = await app.inject({ method: 'GET', url: `${AUTH}/gitlab/callback?code=bad` })
    assert.equal(response.statusCode, 302)
    assert.ok(response.headers.location?.includes('error=gitlab_failed'))
  })

  it('profile fetch fails → redirect to login?error=gitlab_failed', async () => {
    const agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
    const pool = agent.get(GITLAB_URL)
    pool.intercept({ path: '/oauth/token', method: 'POST' }).reply(200, { access_token: 'gl-token' })
    pool.intercept({ path: '/api/v4/user', method: 'GET' }).reply(401, { message: 'Unauthorized' })

    const response = await app.inject({ method: 'GET', url: `${AUTH}/gitlab/callback?code=valid` })
    assert.equal(response.statusCode, 302)
    assert.ok(response.headers.location?.includes('error=gitlab_failed'))
  })

  it('success → redirect to /auth/callback, sets refresh_token cookie', async () => {
    const agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
    const pool = agent.get(GITLAB_URL)
    pool.intercept({ path: '/oauth/token', method: 'POST' }).reply(200, { access_token: 'gl-token' })
    pool.intercept({ path: '/api/v4/user', method: 'GET' }).reply(200, mockGitlabUser)

    const response = await app.inject({ method: 'GET', url: `${AUTH}/gitlab/callback?code=valid` })
    assert.equal(response.statusCode, 302)
    assert.ok(response.headers.location?.includes('/auth/callback'))
    const cookies = response.headers['set-cookie']
    assert.ok(cookies, 'set-cookie header should be present')
    const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : cookies
    assert.ok(cookieStr.includes('refresh_token='))
  })
})
