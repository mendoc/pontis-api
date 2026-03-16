export const REFRESH_COOKIE = 'refresh_token'
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000

export const cookieOpts = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/',
  maxAge: REFRESH_TTL_MS / 1000,
}
