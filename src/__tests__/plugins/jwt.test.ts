import { describe, it, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { buildTestApp, TEST_PRIVATE_KEY } from '../helpers/build'
import type { FastifyInstance } from 'fastify'
import type { JwtPayload } from '../../plugins/jwt'

describe('jwt plugin', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildTestApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('generateTokens returns accessToken and refreshToken strings', () => {
    const payload: JwtPayload = { sub: 'user-1', email: 'user@example.com', role: 'developer' as const }
    const tokens = app.generateTokens(payload)
    assert.equal(typeof tokens.accessToken, 'string')
    assert.equal(typeof tokens.refreshToken, 'string')
    assert.ok(tokens.accessToken.length > 0)
    assert.ok(tokens.refreshToken.length > 0)
  })

  it('verifyAccessToken decodes payload correctly (sub, email, iss)', () => {
    const payload: JwtPayload = { sub: 'user-42', email: 'decode@example.com', role: 'developer' as const }
    const { accessToken } = app.generateTokens(payload)
    const decoded = app.verifyAccessToken(accessToken)
    assert.equal(decoded.sub, payload.sub)
    assert.equal(decoded.email, payload.email)
    assert.equal((decoded as any).iss, 'pontis')
  })

  it('verifyAccessToken throws on tampered token', () => {
    const payload: JwtPayload = { sub: 'user-1', email: 'user@example.com', role: 'developer' as const }
    const { accessToken } = app.generateTokens(payload)
    const parts = accessToken.split('.')
    parts[2] = parts[2].split('').reverse().join('')
    const tampered = parts.join('.')
    assert.throws(() => app.verifyAccessToken(tampered))
  })

  it('verifyRefreshToken decodes sub correctly', () => {
    const payload: JwtPayload = { sub: 'user-99', email: 'refresh@example.com', role: 'developer' as const }
    const { refreshToken } = app.generateTokens(payload)
    const decoded = app.verifyRefreshToken(refreshToken)
    assert.equal(decoded.sub, payload.sub)
  })

  it('verifyRefreshToken throws on invalid token', () => {
    assert.throws(() => app.verifyRefreshToken('not.a.valid.token'))
  })

  it('access token has correct 15min expiry (exp - iat === 900)', () => {
    const payload: JwtPayload = { sub: 'user-1', email: 'user@example.com', role: 'developer' as const }
    const { accessToken } = app.generateTokens(payload)
    const decoded = jwt.decode(accessToken) as { exp: number; iat: number }
    assert.ok(decoded.exp !== undefined)
    assert.ok(decoded.iat !== undefined)
    assert.equal(decoded.exp - decoded.iat, 900)
  })

  it('verifyAccessToken throws when signed with a different private key', () => {
    const differentToken = jwt.sign(
      { sub: 'user-x', email: 'x@example.com', iss: 'pontis' },
      'wrong-secret',
      { algorithm: 'HS256' }
    )
    assert.throws(() => app.verifyAccessToken(differentToken))
  })
})
