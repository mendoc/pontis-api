import { z } from 'zod'

export const CreateProjectBody = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9 _-]+$/),
})
