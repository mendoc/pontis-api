export type AuthErrorCode =
  | 'EMAIL_TAKEN'
  | 'INVALID_CREDENTIALS'
  | 'NO_REFRESH_TOKEN'
  | 'INVALID_REFRESH_TOKEN'
  | 'REFRESH_TOKEN_REUSE'
  | 'USER_NOT_FOUND'
  | 'GITLAB_NOT_CONFIGURED'
  | 'GITLAB_TOKEN_EXCHANGE_FAILED'
  | 'GITLAB_PROFILE_FETCH_FAILED'

export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}
