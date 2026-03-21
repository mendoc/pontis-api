export type AuthErrorCode =
  | 'EMAIL_TAKEN'
  | 'INVALID_CREDENTIALS'
  | 'SSO_ACCOUNT_NO_PASSWORD'
  | 'NO_REFRESH_TOKEN'
  | 'INVALID_REFRESH_TOKEN'
  | 'REFRESH_TOKEN_REUSE'
  | 'USER_NOT_FOUND'
  | 'GITLAB_NOT_CONFIGURED'
  | 'GITLAB_TOKEN_EXCHANGE_FAILED'
  | 'GITLAB_PROFILE_FETCH_FAILED'
  | 'RESET_CODE_INVALID'
  | 'RESET_CODE_EXPIRED'
  | 'SSO_ACCOUNT_RESET_NOT_ALLOWED'
  | 'EMAIL_NOT_FOUND'

export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}
