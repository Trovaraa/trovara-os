import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { securityMiddleware } from './security.js'

function app() {
  const instance = new Hono()
  const [requestIdMiddleware] = securityMiddleware()
  instance.use('*', requestIdMiddleware)
  instance.get('/ok', (c) => c.json({ ok: true }))
  return instance
}

describe('request ID middleware', () => {
  it('propagates a valid caller request ID', async () => {
    const response = await app().request('/ok', {
      headers: { 'x-request-id': 'edge-req-123' },
    })

    expect(response.headers.get('x-request-id')).toBe('edge-req-123')
  })

  it('replaces an invalid request ID', async () => {
    const response = await app().request('/ok', {
      headers: { 'x-request-id': 'contains spaces' },
    })

    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })
})
