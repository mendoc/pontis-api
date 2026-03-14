import { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcrypt'
import { fetch } from 'undici'
import { RegisterBody, LoginBody } from './schemas'

const REFRESH_COOKIE = 'refresh_token'
const BCRYPT_ROUNDS = 12

const cookieOpts = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
  maxAge: 60 * 60 * 24 * 7, // 7 days in seconds
}

const authRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /auth/register
  fastify.post('/register', async (request, reply) => {
    const result = RegisterBody.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({ error: result.error.flatten() })
    }

    const { email, password } = result.data

    const existing = await fastify.prisma.user.findUnique({ where: { email } })
    if (existing) {
      return reply.status(409).send({ error: 'Email already registered' })
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
    const user = await fastify.prisma.user.create({
      data: { email, passwordHash },
    })

    const tokens = fastify.generateTokens({ sub: user.id, email: user.email })

    reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, cookieOpts)
    return reply.status(201).send({ accessToken: tokens.accessToken, userId: user.id })
  })

  // POST /auth/login
  fastify.post('/login', async (request, reply) => {
    const result = LoginBody.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({ error: result.error.flatten() })
    }

    const { email, password } = result.data

    const user = await fastify.prisma.user.findUnique({ where: { email } })
    if (!user || !user.passwordHash) {
      return reply.status(401).send({ error: 'Invalid credentials' })
    }

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid credentials' })
    }

    const tokens = fastify.generateTokens({ sub: user.id, email: user.email })

    reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, cookieOpts)
    return reply.send({ accessToken: tokens.accessToken, userId: user.id })
  })

  // POST /auth/refresh
  fastify.post('/refresh', async (request, reply) => {
    const token = request.cookies?.[REFRESH_COOKIE]
    if (!token) {
      return reply.status(401).send({ error: 'No refresh token' })
    }

    let payload: { sub: string }
    try {
      payload = fastify.verifyRefreshToken(token) as { sub: string }
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired refresh token' })
    }

    const user = await fastify.prisma.user.findUnique({ where: { id: payload.sub } })
    if (!user) {
      return reply.status(401).send({ error: 'User not found' })
    }

    const tokens = fastify.generateTokens({ sub: user.id, email: user.email })

    reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, cookieOpts)
    return reply.send({ accessToken: tokens.accessToken })
  })

  // GET /auth/logout
  fastify.get('/logout', async (_request, reply) => {
    reply.clearCookie(REFRESH_COOKIE, { path: '/' })
    return reply.send({ ok: true })
  })

  // GET /auth/gitlab — redirect to GitLab OAuth2
  fastify.get('/gitlab', async (_request, reply) => {
    const gitlabUrl = process.env.GITLAB_URL
    const clientId = process.env.GITLAB_CLIENT_ID
    const callbackUrl = process.env.GITLAB_CALLBACK_URL

    if (!gitlabUrl || !clientId || !callbackUrl) {
      return reply.status(503).send({ error: 'GitLab OAuth2 not configured' })
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: 'read_user',
    })

    return reply.redirect(`${gitlabUrl}/oauth/authorize?${params}`)
  })

  // GET /auth/gitlab/callback
  fastify.get('/gitlab/callback', async (request, reply) => {
    const { code } = request.query as { code?: string }
    if (!code) {
      return reply.status(400).send({ error: 'Missing OAuth2 code' })
    }

    const gitlabUrl = process.env.GITLAB_URL
    const clientId = process.env.GITLAB_CLIENT_ID
    const clientSecret = process.env.GITLAB_CLIENT_SECRET
    const callbackUrl = process.env.GITLAB_CALLBACK_URL

    if (!gitlabUrl || !clientId || !clientSecret || !callbackUrl) {
      return reply.status(503).send({ error: 'GitLab OAuth2 not configured' })
    }

    // Exchange code for token
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

    if (!tokenRes.ok) {
      return reply.status(502).send({ error: 'Failed to exchange GitLab code' })
    }

    const tokenData = (await tokenRes.json()) as { access_token: string }

    // Fetch GitLab user profile
    const profileRes = await fetch(`${gitlabUrl}/api/v4/user`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })

    if (!profileRes.ok) {
      return reply.status(502).send({ error: 'Failed to fetch GitLab user profile' })
    }

    const profile = (await profileRes.json()) as { id: number; email: string }

    // Upsert user
    const user = await fastify.prisma.user.upsert({
      where: { gitlabId: profile.id },
      update: { gitlabToken: tokenData.access_token, email: profile.email },
      create: {
        email: profile.email,
        gitlabId: profile.id,
        gitlabToken: tokenData.access_token,
      },
    })

    const tokens = fastify.generateTokens({ sub: user.id, email: user.email })

    reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, cookieOpts)
    return reply.send({ accessToken: tokens.accessToken, userId: user.id })
  })
}

export default authRoutes
