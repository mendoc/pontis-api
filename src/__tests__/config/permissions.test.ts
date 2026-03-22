import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { hasPermission, ROLE_PERMISSIONS } from '../../config/permissions'

describe('hasPermission', () => {
  it('developer has projects:list', () => {
    assert.equal(hasPermission('developer', 'projects:list'), true)
  })

  it('developer has projects:create', () => {
    assert.equal(hasPermission('developer', 'projects:create'), true)
  })

  it('developer has projects:deployments:rollback', () => {
    assert.equal(hasPermission('developer', 'projects:deployments:rollback'), true)
  })

  it('developer does NOT have projects:debug', () => {
    assert.equal(hasPermission('developer', 'projects:debug'), false)
  })

  it('developer does NOT have users:list', () => {
    assert.equal(hasPermission('developer', 'users:list'), false)
  })

  it('developer does NOT have users:update', () => {
    assert.equal(hasPermission('developer', 'users:update'), false)
  })

  it('admin has projects:debug', () => {
    assert.equal(hasPermission('admin', 'projects:debug'), true)
  })

  it('admin has users:list', () => {
    assert.equal(hasPermission('admin', 'users:list'), true)
  })

  it('admin has users:update', () => {
    assert.equal(hasPermission('admin', 'users:update'), true)
  })

  it('admin has users:delete', () => {
    assert.equal(hasPermission('admin', 'users:delete'), true)
  })

  it('admin has all developer permissions', () => {
    const developerPerms = ROLE_PERMISSIONS['developer']
    for (const perm of developerPerms) {
      assert.equal(hasPermission('admin', perm), true, `admin should have ${perm}`)
    }
  })

  it('admin has more permissions than developer', () => {
    const devCount = ROLE_PERMISSIONS['developer'].length
    const adminCount = ROLE_PERMISSIONS['admin'].length
    assert.ok(adminCount > devCount, 'admin should have more permissions than developer')
  })
})
