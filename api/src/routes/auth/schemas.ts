import { z } from 'zod'

export const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

export const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export type RegisterBodyType = z.infer<typeof RegisterBody>
export type LoginBodyType = z.infer<typeof LoginBody>
