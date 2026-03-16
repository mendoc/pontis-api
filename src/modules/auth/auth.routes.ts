import { FastifyPluginAsync } from 'fastify'
import { AuthError, AuthErrorCode } from './auth.errors'
import { RegisterBody, LoginBody } from './auth.schemas'
import { AuthService } from './auth.service'
import { REFRESH_COOKIE, cookieOpts } from '../../config/cookies'

const HTTP_STATUS: Record<AuthErrorCode, number> = {
  EMAIL_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  NO_REFRESH_TOKEN: 401,
  INVALID_REFRESH_TOKEN: 401,
  REFRESH_TOKEN_REUSE: 401,
  USER_NOT_FOUND: 401,
  GITLAB_NOT_CONFIGURED: 503,
  GITLAB_TOKEN_EXCHANGE_FAILED: 502,
  GITLAB_PROFILE_FETCH_FAILED: 502,
}

const authRoutes: FastifyPluginAsync = async (fastify) => {
  const svc = new AuthService(fastify.prisma, {
    generateTokens: (payload, familyId) => fastify.generateTokens(payload, familyId),
    verifyRefreshToken: (token) => fastify.verifyRefreshToken(token),
  })

  // POST /auth/register
  fastify.post('/register', async (request, reply) => {
    const result = RegisterBody.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({ error: result.error.flatten() })
    }

    try {
      const { email, password } = result.data
      const { accessToken, refreshToken, userId } = await svc.register(email, password)
      reply.setCookie(REFRESH_COOKIE, refreshToken, cookieOpts)
      return reply.status(201).send({ accessToken, userId })
    } catch (err) {
      if (err instanceof AuthError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // POST /auth/login
  fastify.post('/login', async (request, reply) => {
    const result = LoginBody.safeParse(request.body)
    if (!result.success) {
      return reply.status(400).send({ error: result.error.flatten() })
    }

    try {
      const { email, password } = result.data
      const { accessToken, refreshToken, userId } = await svc.login(email, password)
      reply.setCookie(REFRESH_COOKIE, refreshToken, cookieOpts)
      return reply.send({ accessToken, userId })
    } catch (err) {
      if (err instanceof AuthError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // POST /auth/refresh
  fastify.post('/refresh', async (request, reply) => {
    const token = request.cookies?.[REFRESH_COOKIE]
    if (!token) {
      return reply.status(401).send({ error: 'No refresh token' })
    }

    try {
      const { accessToken, refreshToken } = await svc.refresh(token)
      reply.setCookie(REFRESH_COOKIE, refreshToken, cookieOpts)
      return reply.send({ accessToken })
    } catch (err) {
      if (err instanceof AuthError) {
        if (err.code === 'REFRESH_TOKEN_REUSE') reply.clearCookie(REFRESH_COOKIE, { path: '/' })
        return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      }
      throw err
    }
  })

  // GET /auth/logout
  fastify.get('/logout', async (request, reply) => {
    const token = request.cookies?.[REFRESH_COOKIE]
    await svc.logout(token)
    reply.clearCookie(REFRESH_COOKIE, { path: '/' })
    return reply.send({ ok: true })
  })

  // GET /auth/gitlab — redirect to GitLab OAuth2
  fastify.get('/gitlab', async (_request, reply) => {
    try {
      const url = svc.getGitLabRedirectUrl()
      return reply.redirect(url)
    } catch (err) {
      if (err instanceof AuthError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })

  // GET /auth/gitlab/callback
  fastify.get('/gitlab/callback', async (request, reply) => {
    const { code } = request.query as { code?: string }
    if (!code) {
      return reply.status(400).send({ error: 'Missing OAuth2 code' })
    }

    try {
      const { accessToken, refreshToken, userId } = await svc.gitlabCallback(code)
      reply.setCookie(REFRESH_COOKIE, refreshToken, cookieOpts)
      return reply.send({ accessToken, userId })
    } catch (err) {
      if (err instanceof AuthError) return reply.status(HTTP_STATUS[err.code]).send({ error: err.message })
      throw err
    }
  })
}

export default authRoutes
