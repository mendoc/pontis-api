import { z } from 'zod'

export const CreateProjectBody = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9 _-]+$/),
  type: z.enum(['static', 'docker']).default('static'),
  internalPort: z.number().int().min(1).max(65535).default(8000).optional(),
  healthcheckPath: z.string().startsWith('/').default('/health').optional(),
})

export const UpsertEnvVarBody = z.object({
  key: z.string().min(1).regex(/^[A-Z_][A-Z0-9_]*$/i, 'Clé env var invalide (lettres, chiffres, underscores)'),
  value: z.string(),
})
