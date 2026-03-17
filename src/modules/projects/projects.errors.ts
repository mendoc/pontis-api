export type ProjectErrorCode =
  | 'PROJECT_NAME_TAKEN'
  | 'PROJECT_NOT_FOUND'
  | 'BUILD_FAILED'

export class ProjectError extends Error {
  constructor(public readonly code: ProjectErrorCode, message: string) {
    super(message)
    this.name = 'ProjectError'
  }
}
