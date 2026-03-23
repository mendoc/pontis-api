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
  create?: AnyFn
  update?: AnyFn
  findUnique?: AnyFn
  findFirst?: AnyFn
  delete?: AnyFn
}

export interface MockEnvVarMethods {
  findMany?: AnyFn
  findFirst?: AnyFn
  create?: AnyFn
  createMany?: AnyFn
  update?: AnyFn
  delete?: AnyFn
}

export interface MockDeploymentMethods {
  create?: AnyFn
  update?: AnyFn
  findFirst?: AnyFn
  findMany?: AnyFn
  count?: AnyFn
  delete?: AnyFn
}

export interface MockPrismaMethods {
  user?: MockUserMethods
  refreshToken?: MockRefreshTokenMethods
  passwordResetCode?: MockPasswordResetCodeMethods
  project?: MockProjectMethods
  envVar?: MockEnvVarMethods
  deployment?: MockDeploymentMethods
  transaction?: (ops: any[]) => Promise<any[]>
}

export function makeMockPrisma(methods: MockPrismaMethods = {}): PrismaClient {
  const {
    user = {},
    refreshToken = {},
    passwordResetCode = {},
    project = {},
    envVar = {},
    deployment = {},
    transaction,
  } = methods

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
      create: project.create ?? (async (args: any) => ({ id: 'proj-uuid', slug: 'test-proj', domain: null, status: 'building', type: 'static', internalPort: 8000, healthcheckPath: '/health', ...args.data })),
      update: project.update ?? (async (args: any) => ({ id: args.where?.id ?? 'proj-uuid', ...args.data })),
      findUnique: project.findUnique ?? (async () => null),
      findFirst: project.findFirst ?? (async () => null),
      delete: project.delete ?? (async () => ({})),
    },
    envVar: {
      findMany: envVar.findMany ?? (async () => []),
      findFirst: envVar.findFirst ?? (async () => null),
      create: envVar.create ?? (async (args: any) => ({ id: 'ev-uuid', ...args.data })),
      createMany: envVar.createMany ?? (async () => ({ count: 0 })),
      update: envVar.update ?? (async (args: any) => ({ id: args.where?.id ?? 'ev-uuid', ...args.data })),
      delete: envVar.delete ?? (async () => ({})),
    },
    deployment: {
      create: deployment.create ?? (async (args: any) => ({ id: 'dep-uuid', status: 'building', ...args.data })),
      update: deployment.update ?? (async (args: any) => ({ id: args.where?.id ?? 'dep-uuid', ...args.data })),
      findFirst: deployment.findFirst ?? (async () => null),
      findMany: deployment.findMany ?? (async () => []),
      count: deployment.count ?? (async () => 0),
      delete: deployment.delete ?? (async () => ({})),
    },
    $transaction: transaction
      ? transaction
      : async (ops: any[]) => Promise.all(ops),
    $connect: async () => {},
    $disconnect: async () => {},
  } as unknown as PrismaClient
}
