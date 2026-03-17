import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import jwt from 'jsonwebtoken'
import forge from 'node-forge'
import { randomUUID } from 'node:crypto'

export interface JwtPayload {
  sub: string
  email: string
  name?: string
}

export interface RefreshPayload {
  sub: string
  familyId: string
}

declare module 'fastify' {
  interface FastifyInstance {
    generateTokens: (payload: JwtPayload, familyId?: string) => { accessToken: string; refreshToken: string; familyId: string }
    verifyAccessToken: (token: string) => JwtPayload
    verifyRefreshToken: (token: string) => RefreshPayload
  }
}

function generateRsaKeyPair(): { privateKey: string; publicKey: string } {
  const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 })
  return {
    privateKey: forge.pki.privateKeyToPem(keypair.privateKey),
    publicKey: forge.pki.publicKeyToPem(keypair.publicKey),
  }
}

const jwtPlugin: FastifyPluginAsync = fp(async (fastify) => {
  let privateKey = process.env.JWT_PRIVATE_KEY
  let publicKey = process.env.JWT_PUBLIC_KEY
  const refreshSecret = process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret'

  if (!privateKey || !publicKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_PRIVATE_KEY and JWT_PUBLIC_KEY must be set in production')
    }
    fastify.log.warn('JWT keys not set — generating ephemeral RS256 keypair (dev only)')
    const keys = generateRsaKeyPair()
    privateKey = keys.privateKey
    publicKey = keys.publicKey
  }

  const _privateKey = privateKey
  const _publicKey = publicKey

  fastify.decorate('generateTokens', (payload: JwtPayload, familyId?: string) => {
    const fid = familyId ?? randomUUID()

    const accessToken = jwt.sign(payload, _privateKey, {
      algorithm: 'RS256',
      expiresIn: '15m',
      issuer: 'pontis',
    })

    const refreshToken = jwt.sign({ sub: payload.sub, familyId: fid }, refreshSecret, {
      algorithm: 'HS256',
      expiresIn: '7d',
      issuer: 'pontis',
    })

    return { accessToken, refreshToken, familyId: fid }
  })

  fastify.decorate('verifyAccessToken', (token: string): JwtPayload => {
    return jwt.verify(token, _publicKey, {
      algorithms: ['RS256'],
      issuer: 'pontis',
    }) as JwtPayload
  })

  fastify.decorate('verifyRefreshToken', (token: string): RefreshPayload => {
    return jwt.verify(token, refreshSecret, {
      algorithms: ['HS256'],
      issuer: 'pontis',
    }) as RefreshPayload
  })
})

export default jwtPlugin
