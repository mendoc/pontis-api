import { describe, it, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { buildTestApp, TEST_PRIVATE_KEY } from '../helpers/build'
import { authenticate } from '../../middleware/authenticate'
import type { FastifyInstance, FastifyRequest } from 'fastify'

describe('authenticate middleware', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildTestApp({
      onRegister: (instance) => {
        instance.get('/protected', { preHandler: authenticate }, async (request: FastifyRequest) => {
          return { userId: request.user.sub }
        })
      },
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('missing Authorization header → 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/protected' })
    assert.equal(response.statusCode, 401)
  })

  it('header without Bearer prefix → 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Basic sometoken' },
    })
    assert.equal(response.statusCode, 401)
  })

  it('valid Bearer token → 200, returns { userId }', async () => {
    const { accessToken } = app.generateTokens({ sub: 'user-1', email: 'user@example.com', role: 'developer' as const })
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json<{ userId: string }>()
    assert.equal(body.userId, 'user-1')
  })

  it('invalid/garbage token → 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer thisisnotavalidtoken' },
    })
    assert.equal(response.statusCode, 401)
  })

  it('expired token → 401', async () => {
    const expiredToken = jwt.sign(
      { sub: 'user-1', email: 'user@example.com', iss: 'pontis' },
      TEST_PRIVATE_KEY,
      { algorithm: 'RS256', expiresIn: -1 }
    )
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${expiredToken}` },
    })
    assert.equal(response.statusCode, 401)
  })
})
