import bcrypt from 'bcrypt'
import { fetch } from 'undici'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { hashToken } from '../../lib/hash'
import { sendPasswordResetEmail } from '../../lib/mailer'
import { AuthError } from './auth.errors'
import type { JwtPayload } from '../../plugins/jwt'

interface RefreshPayload {
  sub: string
  familyId: string
}
import { REFRESH_TTL_MS } from '../../config/cookies'

export interface JwtOperations {
  generateTokens(
    payload: JwtPayload,
    familyId?: string,
  ): { accessToken: string; refreshToken: string; familyId: string }
  verifyRefreshToken(token: string): RefreshPayload
}

export class AuthService {
  private bcryptRounds: number

  constructor(
    private prisma: PrismaClient,
    private jwt: JwtOperations,
    bcryptRounds?: number,
  ) {
    this.bcryptRounds = bcryptRounds ?? parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10)
  }

  async register(
    email: string,
    password: string,
  ): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
    const existing = await this.prisma.user.findUnique({ where: { email } })
    if (existing) throw new AuthError('EMAIL_TAKEN', 'Email already registered')

    const passwordHash = await bcrypt.hash(password, this.bcryptRounds)
    const user = await this.prisma.user.create({ data: { email, passwordHash } })

    const familyId = randomUUID()
    const tokens = this.jwt.generateTokens({ sub: user.id, email: user.email, name: user.name ?? undefined, role: user.role }, familyId)
    await this.storeRefreshToken(user.id, familyId, tokens.refreshToken)

    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, userId: user.id }
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
    const user = await this.prisma.user.findUnique({ where: { email } })
    if (!user) throw new AuthError('INVALID_CREDENTIALS', 'Invalid credentials')
    if (user.blocked) throw new AuthError('USER_BLOCKED', 'Account blocked')
    if (!user.passwordHash) throw new AuthError('SSO_ACCOUNT_NO_PASSWORD', 'SSO account has no password')

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) throw new AuthError('INVALID_CREDENTIALS', 'Invalid credentials')

    const familyId = randomUUID()
    const tokens = this.jwt.generateTokens({ sub: user.id, email: user.email, name: user.name ?? undefined, role: user.role }, familyId)
    await this.storeRefreshToken(user.id, familyId, tokens.refreshToken)

    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, userId: user.id }
  }

  async refresh(rawToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    let payload: RefreshPayload
    try {
      payload = this.jwt.verifyRefreshToken(rawToken)
    } catch {
      throw new AuthError('INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token')
    }

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
    })

    if (!stored) {
      throw new AuthError('INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token')
    }

    if (stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      throw new AuthError('REFRESH_TOKEN_REUSE', 'Refresh token reuse detected')
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } })
    if (!user) throw new AuthError('USER_NOT_FOUND', 'User not found')
    if (user.blocked) throw new AuthError('USER_BLOCKED', 'Account blocked')

    const { accessToken } = this.jwt.generateTokens({ sub: user.id, email: user.email, name: user.name ?? undefined, role: user.role }, stored.familyId)

    return { accessToken, refreshToken: rawToken }
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return
    try {
      this.jwt.verifyRefreshToken(rawToken)
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash: hashToken(rawToken), revokedAt: null },
        data: { revokedAt: new Date() },
      })
    } catch {
      // Token invalid or expired — still clear the cookie
    }
  }

  getGitLabRedirectUrl(): string {
    const gitlabUrl = process.env.GITLAB_URL
    const clientId = process.env.GITLAB_CLIENT_ID
    const callbackUrl = process.env.GITLAB_CALLBACK_URL

    if (!gitlabUrl || !clientId || !callbackUrl) {
      throw new AuthError('GITLAB_NOT_CONFIGURED', 'GitLab OAuth2 not configured')
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: 'read_user',
    })

    return `${gitlabUrl}/oauth/authorize?${params}`
  }

  async gitlabCallback(
    code: string,
  ): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
    const gitlabUrl = process.env.GITLAB_URL
    const clientId = process.env.GITLAB_CLIENT_ID
    const clientSecret = process.env.GITLAB_CLIENT_SECRET
    const callbackUrl = process.env.GITLAB_CALLBACK_URL

    if (!gitlabUrl || !clientId || !clientSecret || !callbackUrl) {
      throw new AuthError('GITLAB_NOT_CONFIGURED', 'GitLab OAuth2 not configured')
    }

    const tokenRes = await fetch(`${gitlabUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: callbackUrl,
      }),
    })

    if (!tokenRes.ok) throw new AuthError('GITLAB_TOKEN_EXCHANGE_FAILED', 'Failed to exchange GitLab code')

    const tokenData = (await tokenRes.json()) as { access_token: string }

    const profileRes = await fetch(`${gitlabUrl}/api/v4/user`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })

    if (!profileRes.ok)
      throw new AuthError('GITLAB_PROFILE_FETCH_FAILED', 'Failed to fetch GitLab user profile')

    const profile = (await profileRes.json()) as { id: number; email: string; name: string }

    const user = await this.prisma.user.upsert({
      where: { gitlabId: profile.id },
      update: { gitlabToken: tokenData.access_token, email: profile.email, name: profile.name },
      create: {
        email: profile.email,
        name: profile.name,
        gitlabId: profile.id,
        gitlabToken: tokenData.access_token,
      },
    })

    const familyId = randomUUID()
    const tokens = this.jwt.generateTokens({ sub: user.id, email: user.email, name: user.name ?? undefined, role: user.role }, familyId)
    await this.storeRefreshToken(user.id, familyId, tokens.refreshToken)

    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, userId: user.id }
  }

  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } })
    if (!user) throw new AuthError('EMAIL_NOT_FOUND', 'Aucun compte associé à cette adresse e-mail')
    if (!user.passwordHash) throw new AuthError('SSO_ACCOUNT_RESET_NOT_ALLOWED', 'SSO account cannot reset password')

    const code = String(Math.floor(100000 + Math.random() * 900000))
    const codeHash = hashToken(code)
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

    await this.prisma.passwordResetCode.create({
      data: { userId: user.id, codeHash, expiresAt },
    })

    await sendPasswordResetEmail(email, code)
  }

  async verifyResetCode(email: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } })
    if (!user) throw new AuthError('RESET_CODE_INVALID', 'Code invalide')

    const record = await this.prisma.passwordResetCode.findFirst({
      where: { userId: user.id, codeHash: hashToken(code), usedAt: null },
      orderBy: { createdAt: 'desc' },
    })

    if (!record) throw new AuthError('RESET_CODE_INVALID', 'Code invalide')
    if (record.expiresAt < new Date()) throw new AuthError('RESET_CODE_EXPIRED', 'Code expiré')
  }

  async resetPassword(
    email: string,
    code: string,
    newPassword: string,
  ): Promise<{ accessToken: string; refreshToken: string; userId: string }> {
    const user = await this.prisma.user.findUnique({ where: { email } })
    if (!user) throw new AuthError('RESET_CODE_INVALID', 'Code invalide')

    const record = await this.prisma.passwordResetCode.findFirst({
      where: { userId: user.id, codeHash: hashToken(code), usedAt: null },
      orderBy: { createdAt: 'desc' },
    })

    if (!record) throw new AuthError('RESET_CODE_INVALID', 'Code invalide')
    if (record.expiresAt < new Date()) throw new AuthError('RESET_CODE_EXPIRED', 'Code expiré')

    const passwordHash = await bcrypt.hash(newPassword, this.bcryptRounds)

    await this.prisma.$transaction([
      this.prisma.passwordResetCode.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ])

    const familyId = randomUUID()
    const tokens = this.jwt.generateTokens({ sub: user.id, email: user.email, name: user.name ?? undefined, role: user.role }, familyId)
    await this.storeRefreshToken(user.id, familyId, tokens.refreshToken)

    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, userId: user.id }
  }

  private async storeRefreshToken(
    userId: string,
    familyId: string,
    refreshToken: string,
  ): Promise<void> {
    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    })
  }
}
