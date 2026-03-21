export type Permission =
  | 'projects:list'
  | 'projects:create'
  | 'projects:read'
  | 'projects:update'
  | 'projects:delete'
  | 'projects:start'
  | 'projects:stop'
  | 'projects:restart'
  | 'projects:deploy'
  | 'projects:deployments:list'
  | 'projects:deployments:read'
  | 'projects:deployments:delete'
  | 'projects:deployments:rollback'
  | 'projects:debug'
  | 'users:list'
  | 'users:read'
  | 'users:update'
  | 'users:delete'

const DEVELOPER_PERMISSIONS: Permission[] = [
  'projects:list',
  'projects:create',
  'projects:read',
  'projects:update',
  'projects:delete',
  'projects:start',
  'projects:stop',
  'projects:restart',
  'projects:deploy',
  'projects:deployments:list',
  'projects:deployments:read',
  'projects:deployments:delete',
  'projects:deployments:rollback',
]

const ALL_PERMISSIONS: Permission[] = [
  ...DEVELOPER_PERMISSIONS,
  'projects:debug',
  'users:list',
  'users:read',
  'users:update',
  'users:delete',
]

export const ROLE_PERMISSIONS: Record<'developer' | 'admin', Permission[]> = {
  developer: DEVELOPER_PERMISSIONS,
  admin: ALL_PERMISSIONS,
}

export function hasPermission(role: 'developer' | 'admin', permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false
}
