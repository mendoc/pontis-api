import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcrypt'
import { AuthService, JwtOperations } from '../../modules/auth/auth.service'
import { AuthError } from '../../modules/auth/auth.errors'
import { makeMockPrisma } from '../helpers/prisma'
import type { JwtPayload } from '../../plugins/jwt'

const makeJwt = (): JwtOperations => ({
  generateTokens: (_payload: JwtPayload, familyId?: string) => ({
    accessToken: 'at-' + randomUUID(),
    refreshToken: 'rt-' + randomUUID(),
    familyId: familyId ?? randomUUID(),
  }),
  verifyRefreshToken: (token: string) => {
    if (token.startsWith('rt-')) {
      return { sub: 'user-id', familyId: 'fam-id' }
    }
    throw new Error('Invalid token')
  },
})

const mockUserBase = {
  id: 'user-uuid-1',
  email: 'test@example.com',
  gitlabId: null,
  gitlabToken: null,
  createdAt: new Date(),
}

// ------------------------------------------------------------------ register
describe('AuthService.register', () => {
  it('throws EMAIL_TAKEN when email already in use', async () => {
    const svc = new AuthService(
      makeMockPrisma({ user: { findUnique: async () => ({ ...mockUserBase, passwordHash: 'hash' }) } }),
      makeJwt(),
      1,
    )
    await assert.rejects(
      () => svc.register('test@example.com', 'password123'),
      (err: AuthError) => {
        assert.equal(err.code, 'EMAIL_TAKEN')
        return true
      },
    )
  })

  it('returns accessToken, refreshToken and userId on success', async () => {
    const svc = new AuthService(
      makeMockPrisma({
        user: {
          findUnique: async () => null,
          create: async (args: any) => ({
            id: 'new-user-id',
            email: args.data.email,
            passwordHash: args.data.passwordHash,
            gitlabId: null,
            gitlabToken: null,
            createdAt: new Date(),
          }),
        },
      }),
      makeJwt(),
      1,
    )
    const result = await svc.register('new@example.com', 'password123')
    assert.ok(typeof result.accessToken === 'string' && result.accessToken.length > 0)
    assert.ok(typeof result.refreshToken === 'string' && result.refreshToken.length > 0)
    assert.equal(result.userId, 'new-user-id')
  })
})

// ------------------------------------------------------------------ login
describe('AuthService.login', () => {
  it('returns tokens and userId on success', async () => {
    const passwordHash = await bcrypt.hash('password123', 1)
    const svc = new AuthService(
      makeMockPrisma({ user: { findUnique: async () => ({ ...mockUserBase, passwordHash }) } }),
      makeJwt(),
      1,
    )
    const result = await svc.login('test@example.com', 'password123')
    assert.ok(typeof result.accessToken === 'string' && result.accessToken.length > 0)
    assert.ok(typeof result.refreshToken === 'string' && result.refreshToken.length > 0)
    assert.equal(result.userId, mockUserBase.id)
  })

  it('throws INVALID_CREDENTIALS for wrong password', async () => {
    const passwordHash = await bcrypt.hash('password123', 1)
    const svc = new AuthService(
      makeMockPrisma({ user: { findUnique: async () => ({ ...mockUserBase, passwordHash }) } }),
      makeJwt(),
      1,
    )
    await assert.rejects(
      () => svc.login('test@example.com', 'wrongpassword'),
      (err: AuthError) => {
        assert.equal(err.code, 'INVALID_CREDENTIALS')
        return true
      },
    )
  })
})

// ------------------------------------------------------------------ refresh
describe('AuthService.refresh', () => {
  it('throws REFRESH_TOKEN_REUSE and revokes family when token already revoked', async () => {
    const familyId = randomUUID()
    let familyRevoked = false

    const svc = new AuthService(
      makeMockPrisma({
        refreshToken: {
          findUnique: async () => ({
            id: 'rt-old',
            familyId,
            tokenHash: 'whatever',
            revokedAt: new Date(),
          }),
          updateMany: async () => {
            familyRevoked = true
            return { count: 1 }
          },
        },
      }),
      makeJwt(),
      1,
    )

    await assert.rejects(
      () => svc.refresh('rt-' + randomUUID()),
      (err: AuthError) => {
        assert.equal(err.code, 'REFRESH_TOKEN_REUSE')
        return true
      },
    )
    assert.ok(familyRevoked, 'entire token family should be revoked')
  })
})
