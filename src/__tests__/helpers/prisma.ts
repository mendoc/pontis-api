import { PrismaClient } from '@prisma/client'

type AnyFn = (args: any) => Promise<any>

export interface MockUserMethods {
  findUnique?: AnyFn
  create?: AnyFn
  upsert?: AnyFn
  update?: AnyFn
  findMany?: AnyFn
  count?: AnyFn
}

export interface MockRefreshTokenMethods {
  create?: AnyFn
  findUnique?: AnyFn
  update?: AnyFn
  updateMany?: AnyFn
}

export interface MockPasswordResetCodeMethods {
  create?: AnyFn
  findFirst?: AnyFn
  update?: AnyFn
}

export interface MockProjectMethods {
  findMany?: AnyFn
  count?: AnyFn
}

export interface MockPrismaMethods {
  user?: MockUserMethods
  refreshToken?: MockRefreshTokenMethods
  passwordResetCode?: MockPasswordResetCodeMethods
  project?: MockProjectMethods
  transaction?: (ops: any[]) => Promise<any[]>
}

export function makeMockPrisma(methods: MockPrismaMethods = {}): PrismaClient {
  const { user = {}, refreshToken = {}, passwordResetCode = {}, project = {}, transaction } = methods

  return {
    user: {
      findUnique: user.findUnique ?? (async () => null),
      create: user.create ?? (async (args: any) => ({ id: 'mock-id', role: 'developer', ...args.data })),
      upsert: user.upsert ?? (async (args: any) => ({ id: 'mock-id', role: 'developer', ...args.create })),
      update: user.update ?? (async (args: any) => ({ id: args.where?.id ?? 'mock-id', ...args.data })),
      findMany: user.findMany ?? (async () => []),
      count: user.count ?? (async () => 0),
    },
    refreshToken: {
      create: refreshToken.create ?? (async (args: any) => ({ id: 'mock-rt-id', ...args.data })),
      findUnique: refreshToken.findUnique ?? (async () => null),
      update: refreshToken.update ?? (async () => ({})),
      updateMany: refreshToken.updateMany ?? (async () => ({ count: 0 })),
    },
    passwordResetCode: {
      create: passwordResetCode.create ?? (async () => ({})),
      findFirst: passwordResetCode.findFirst ?? (async () => null),
      update: passwordResetCode.update ?? (async () => ({})),
    },
    project: {
      findMany: project.findMany ?? (async () => []),
      count: project.count ?? (async () => 0),
    },
    $transaction: transaction
      ? transaction
      : async (ops: any[]) => Promise.all(ops),
    $connect: async () => {},
    $disconnect: async () => {},
  } as unknown as PrismaClient
}
