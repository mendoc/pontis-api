import { describe, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcrypt'
import { AuthService, JwtOperations } from '../../modules/auth/auth.service'
import { AuthError } from '../../modules/auth/auth.errors'
import { makeMockPrisma } from '../helpers/prisma'
import { hashToken } from '../../lib/hash'
import type { JwtPayload } from '../../plugins/jwt'

vi.mock('../../lib/mailer', () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}))

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
  role: 'developer' as const,
  blocked: false,
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
            blocked: false,
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

  it('throws INVALID_CREDENTIALS when user not found', async () => {
    const svc = new AuthService(
      makeMockPrisma({ user: { findUnique: async () => null } }),
      makeJwt(),
      1,
    )
    await assert.rejects(
      () => svc.login('nobody@example.com', 'password123'),
      (err: AuthError) => {
        assert.equal(err.code, 'INVALID_CREDENTIALS')
        return true
      },
    )
  })

  it('throws USER_BLOCKED when account is blocked', async () => {
    const passwordHash = await bcrypt.hash('password123', 1)
    const svc = new AuthService(
      makeMockPrisma({
        user: { findUnique: async () => ({ ...mockUserBase, passwordHash, blocked: true }) },
      }),
      makeJwt(),
      1,
    )
    await assert.rejects(
      () => svc.login('test@example.com', 'password123'),
      (err: AuthError) => {
        assert.equal(err.code, 'USER_BLOCKED')
        return true
      },
    )
  })

  it('throws SSO_ACCOUNT_NO_PASSWORD for SSO account without password', async () => {
    const svc = new AuthService(
      makeMockPrisma({
        user: { findUnique: async () => ({ ...mockUserBase, passwordHash: null, gitlabId: 42 }) },
      }),
      makeJwt(),
      1,
    )
    await assert.rejects(
      () => svc.login('test@example.com', 'password123'),
      (err: AuthError) => {
        assert.equal(err.code, 'SSO_ACCOUNT_NO_PASSWORD')
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

  it('throws INVALID_REFRESH_TOKEN when token is malformed', async () => {
    const svc = new AuthService(makeMockPrisma(), makeJwt(), 1)
    await assert.rejects(
      () => svc.refresh('not-a-valid-token'),
      (err: AuthError) => {
        assert.equal(err.code, 'INVALID_REFRESH_TOKEN')
        return true
      },
    )
  })

  it('throws INVALID_REFRESH_TOKEN when token not found in DB', async () => {
    const svc = new AuthService(
      makeMockPrisma({ refreshToken: { findUnique: async () => null } }),
      makeJwt(),
      1,
    )
    await assert.rejects(
      () => svc.refresh('rt-' + randomUUID()),
      (err: AuthError) => {
        assert.equal(err.code, 'INVALID_REFRESH_TOKEN')
        return true
      },
    )
  })

  it('throws USER_NOT_FOUND when user deleted after token issuance', async () => {
    const familyId = randomUUID()
    const rawToken = 'rt-' + randomUUID()
    const svc = new AuthService(
      makeMockPrisma({
        refreshToken: {
          findUnique: async () => ({
            id: 'rt-1',
            familyId,
            tokenHash: hashToken(rawToken),
            revokedAt: null,
          }),
        },
        user: { findUnique: async () => null },
      }),
      makeJwt(),
      1,
    )
    await assert.rejects(
      () => svc.refresh(rawToken),
      (err: AuthError) => {
        assert.equal(err.code, 'USER_NOT_FOUND')
        return true
      },
    )
  })

  it('throws USER_BLOCKED when user is blocked', async () => {
    const familyId = randomUUID()
    const rawToken = 'rt-' + randomUUID()
    const svc = new AuthService(
      makeMockPrisma({
        refreshToken: {
          findUnique: async () => ({
            id: 'rt-1',
            familyId,
            tokenHash: hashToken(rawToken),
            revokedAt: null,
          }),
        },
        user: { findUnique: async () => ({ ...mockUserBase, passwordHash: 'hash', blocked: true }) },
      }),
      makeJwt(),
      1,
    )
    await assert.rejects(
      () => svc.refresh(rawToken),
      (err: AuthError) => {
        assert.equal(err.code, 'USER_BLOCKED')
        return true
      },
    )
  })
})

// ------------------------------------------------------------------ logout
describe('AuthService.logout', () => {
  it('does nothing when token is undefined', async () => {
    let updateManyCalled = false
    const svc = new AuthService(
      makeMockPrisma({
        refreshToken: {
          updateMany: async () => {
            updateManyCalled = true
            return { count: 0 }
          },
        },
      }),
      makeJwt(),
      1,
    )
    await svc.logout(undefined)
    assert.equal(updateManyCalled, false)
  })

  it('revokes the token when valid', async () => {
    let updateManyCalled = false
    const svc = new AuthService(
      makeMockPrisma({
        refreshToken: {
          updateMany: async () => {
            updateManyCalled = true
            return { count: 1 }
          },
        },
      }),
      makeJwt(),
      1,
    )
    await svc.logout('rt-' + randomUUID())
    assert.ok(updateManyCalled, 'updateMany should be called to revoke the token')
  })

  it('does not throw when token is invalid/expired', async () => {
    const svc = new AuthService(makeMockPrisma(), makeJwt(), 1)
    await assert.doesNotReject(() => svc.logout('invalid-token'))
  })
})

// ------------------------------------------------------------------ requestPasswordReset
describe('AuthService.requestPasswordReset', () => {
  it('throws EMAIL_NOT_FOUND when email does not exist', async () => {
    const svc = new AuthService(
      makeMockPrisma({ user: { findUnique: async () => null } }),
      makeJwt(),
      1,
    )
    await assert.rejects(
      () => svc.requestPasswordReset('nobody@example.com'),
      (err: AuthError) => {
        assert.equal(err.code, 'EMAIL_NOT_FOUND')
        return true
      },
    )
  })

  it('throws SSO_ACCOUNT_RESET_NOT_ALLOWED for SSO account without password', async () => {
    const svc = new AuthService(
      makeMockPrisma({
        user: { findUnique: async () => ({ ...mockUserBase, passwordHash: null, gitlabId: 42 }) },
      }),
      makeJwt(),
      1,
    )
    await assert.rejects(
      () => svc.requestPasswordReset('test@example.com'),
      (err: AuthError) => {
        assert.equal(err.code, 'SSO_ACCOUNT_RESET_NOT_ALLOWED')
        return true
      },
    )
  })

  it('creates a reset code and sends email on success', async () => {
    const { sendPasswordResetEmail } = await import('../../lib/mailer')
    const sendMock = vi.mocked(sendPasswordResetEmail)
    sendMock.mockClear()

    let createdCode: any = null
    const svc = new AuthService(
      makeMockPrisma({
        user: { findUnique: async () => ({ ...mockUserBase, passwordHash: 'hash' }) },
        passwordResetCode: {
          create: async (args: any) => {
            createdCode = args.data
            return {}
          },
        },
      }),
      makeJwt(),
      1,
    )

    await svc.requestPasswordReset('test@example.com')

    assert.ok(createdCode, 'reset code record should be created')
    assert.equal(createdCode.userId, mockUserBase.id)
    assert.ok(createdCode.codeHash, 'codeHash should be set')
    assert.ok(createdCode.expiresAt > new Date(), 'expiresAt should be in the future')
    assert.equal(sendMock.mock.calls.length, 1, 'email should be sent once')
    assert.equal(sendMock.mock.calls[0][0], 'test@example.com')
  })
})

// ------------------------------------------------------------------ verifyResetCode
describe('AuthService.verifyResetCode', () => {
  it('throws RESET_CODE_INVALID when user not found', async () => {
    const svc = new AuthService(
      makeMockPrisma({ user: { findUnique: async () => null } }),
      makeJwt(),
      1,
    )
    await assert.rejects(
      () => svc.verifyResetCode('nobody@example.com', '123456'),
      (err: AuthError) => {
        assert.equal(err.code, 'RESET_CODE_INVALID')
        return true
      },
    )
  })

  it('throws RESET_CODE_INVALID when code not found', async () => {
    const svc = new AuthService(
      makeMockPrisma({
        user: { findUnique: async () => ({ ...mockUserBase, passwordHash: 'hash' }) },
        passwordResetCode: { findFirst: async () => null },
      }),
      makeJwt(),
      1,
    )
    await assert.rejects(
      () => svc.verifyResetCode('test@example.com', '000000'),
      (err: AuthError) => {
        assert.equal(err.code, 'RESET_CODE_INVALID')
        return true
      },
    )
  })

  it('throws RESET_CODE_EXPIRED when code is expired', async () => {
    const svc = new AuthService(
      makeMockPrisma({
        user: { findUnique: async () => ({ ...mockUserBase, passwordHash: 'hash' }) },
        passwordResetCode: {
          findFirst: async () => ({
            id: 'rc-1',
            userId: mockUserBase.id,
            codeHash: hashToken('123456'),
            expiresAt: new Date(Date.now() - 1000), // expired 1 second ago
            usedAt: null,
            createdAt: new Date(),
          }),
        },
      }),
      makeJwt(),
      1,
    )
    await assert.rejects(
      () => svc.verifyResetCode('test@example.com', '123456'),
      (err: AuthError) => {
        assert.equal(err.code, 'RESET_CODE_EXPIRED')
        return true
      },
    )
  })

  it('resolves without error for a valid, non-expired code', async () => {
    const svc = new AuthService(
      makeMockPrisma({
        user: { findUnique: async () => ({ ...mockUserBase, passwordHash: 'hash' }) },
        passwordResetCode: {
          findFirst: async () => ({
            id: 'rc-1',
            userId: mockUserBase.id,
            codeHash: hashToken('123456'),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            usedAt: null,
            createdAt: new Date(),
          }),
        },
      }),
      makeJwt(),
      1,
    )
    await assert.doesNotReject(() => svc.verifyResetCode('test@example.com', '123456'))
  })
})

// ------------------------------------------------------------------ resetPassword
describe('AuthService.resetPassword', () => {
  it('throws RESET_CODE_INVALID when user not found', async () => {
    const svc = new AuthService(
      makeMockPrisma({ user: { findUnique: async () => null } }),
      makeJwt(),
      1,
    )
    await assert.rejects(
      () => svc.resetPassword('nobody@example.com', '123456', 'newpassword'),
      (err: AuthError) => {
        assert.equal(err.code, 'RESET_CODE_INVALID')
        return true
      },
    )
  })

  it('throws RESET_CODE_EXPIRED when code is expired', async () => {
    const svc = new AuthService(
      makeMockPrisma({
        user: { findUnique: async () => ({ ...mockUserBase, passwordHash: 'hash' }) },
        passwordResetCode: {
          findFirst: async () => ({
            id: 'rc-1',
            userId: mockUserBase.id,
            codeHash: hashToken('123456'),
            expiresAt: new Date(Date.now() - 1000),
            usedAt: null,
            createdAt: new Date(),
          }),
        },
      }),
      makeJwt(),
      1,
    )
    await assert.rejects(
      () => svc.resetPassword('test@example.com', '123456', 'newpassword'),
      (err: AuthError) => {
        assert.equal(err.code, 'RESET_CODE_EXPIRED')
        return true
      },
    )
  })

  it('resets password, revokes all tokens, and returns new tokens on success', async () => {
    let transactionCalled = false
    let refreshTokenCreated = false

    const svc = new AuthService(
      makeMockPrisma({
        user: { findUnique: async () => ({ ...mockUserBase, passwordHash: 'old-hash' }) },
        passwordResetCode: {
          findFirst: async () => ({
            id: 'rc-1',
            userId: mockUserBase.id,
            codeHash: hashToken('123456'),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
            usedAt: null,
            createdAt: new Date(),
          }),
        },
        transaction: async (ops: any[]) => {
          transactionCalled = true
          return Promise.all(ops)
        },
        refreshToken: {
          create: async () => {
            refreshTokenCreated = true
            return {}
          },
        },
      }),
      makeJwt(),
      1,
    )

    const result = await svc.resetPassword('test@example.com', '123456', 'newpassword123')

    assert.ok(transactionCalled, '$transaction should be called')
    assert.ok(refreshTokenCreated, 'new refresh token should be stored')
    assert.ok(typeof result.accessToken === 'string' && result.accessToken.length > 0)
    assert.ok(typeof result.refreshToken === 'string' && result.refreshToken.length > 0)
    assert.equal(result.userId, mockUserBase.id)
  })
})
