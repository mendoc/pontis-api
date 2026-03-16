import forge from 'node-forge'
import { PrismaClient } from '@prisma/client'
import { buildApp } from '../../app'
import { makeMockPrisma } from './prisma'

// Generate a 1024-bit RSA keypair once at module load (faster than 2048 for tests)
const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048 })
export const TEST_PRIVATE_KEY = forge.pki.privateKeyToPem(keypair.privateKey)
export const TEST_PUBLIC_KEY = forge.pki.publicKeyToPem(keypair.publicKey)
export const TEST_REFRESH_SECRET = 'test-refresh-secret-for-unit-tests'
export const API_PREFIX = '/api/v1'

export interface BuildTestAppOptions {
  prisma?: PrismaClient
  onRegister?: (app: Awaited<ReturnType<typeof buildApp>>) => void
}

export async function buildTestApp(opts: BuildTestAppOptions = {}): Promise<Awaited<ReturnType<typeof buildApp>>> {
  // Set JWT env vars so the jwt plugin uses our test keys
  process.env.JWT_PRIVATE_KEY = TEST_PRIVATE_KEY
  process.env.JWT_PUBLIC_KEY = TEST_PUBLIC_KEY
  process.env.JWT_REFRESH_SECRET = TEST_REFRESH_SECRET

  const app = await buildApp({
    prismaOverride: opts.prisma ?? makeMockPrisma(),
  })

  if (opts.onRegister) {
    opts.onRegister(app)
  }

  return app
}
