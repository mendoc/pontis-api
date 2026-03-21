import { PrismaClient } from '@prisma/client'

type AnyFn = (args: any) => Promise<any>

export interface MockUserMethods {
  findUnique?: AnyFn
  create?: AnyFn
  upsert?: AnyFn
}

export interface MockRefreshTokenMethods {
  create?: AnyFn
  findUnique?: AnyFn
  update?: AnyFn
  updateMany?: AnyFn
}

export interface MockPrismaMethods {
  user?: MockUserMethods
  refreshToken?: MockRefreshTokenMethods
}

export function makeMockPrisma(methods: MockPrismaMethods = {}): PrismaClient {
  const { user = {}, refreshToken = {} } = methods

  return {
    user: {
      findUnique: user.findUnique ?? (async () => null),
      create: user.create ?? (async (args: any) => ({ id: 'mock-id', role: 'developer', ...args.data })),
      upsert: user.upsert ?? (async (args: any) => ({ id: 'mock-id', role: 'developer', ...args.create })),
    },
    refreshToken: {
      create: refreshToken.create ?? (async (args: any) => ({ id: 'mock-rt-id', ...args.data })),
      findUnique: refreshToken.findUnique ?? (async () => null),
      update: refreshToken.update ?? (async () => ({})),
      updateMany: refreshToken.updateMany ?? (async () => ({ count: 0 })),
    },
    $connect: async () => {},
    $disconnect: async () => {},
  } as unknown as PrismaClient
}
