import { describe, it, beforeAll, afterAll } from 'vitest'
import assert from 'node:assert/strict'
import { buildTestApp, API_PREFIX } from '../helpers/build'
import type { FastifyInstance } from 'fastify'

describe('GET /health', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 200 with { status: "ok" }', async () => {
    const response = await app.inject({ method: 'GET', url: `${API_PREFIX}/health` })
    assert.equal(response.statusCode, 200)
    const body = response.json<{ status: string }>()
    assert.equal(body.status, 'ok')
  })
})
