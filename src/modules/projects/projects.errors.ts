export type ProjectErrorCode =
  | 'PROJECT_NAME_TAKEN'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_FORBIDDEN'
  | 'BUILD_FAILED'
  | 'DEPLOYMENT_NOT_FOUND'
  | 'DEPLOYMENT_IN_USE'
  | 'DEPLOYMENT_BUILDING'

export class ProjectError extends Error {
  constructor(public readonly code: ProjectErrorCode, message: string) {
    super(message)
    this.name = 'ProjectError'
  }
}
