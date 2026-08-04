import { describe, expect, it } from 'vitest'
import { selectSecurityDashboardEvents } from './security-log.js'

describe('selectSecurityDashboardEvents', () => {
  it('returns newest useful events and skips csrf/forbidden noise', () => {
    const lines = [
      JSON.stringify({
        ts: '2026-08-04T10:00:00.000Z',
        type: 'login',
        metadata: { email: 'owner@trovara.farm' },
      }),
      JSON.stringify({
        ts: '2026-08-04T10:01:00.000Z',
        type: 'csrf_failure',
        metadata: { path: '/api/graphql' },
      }),
      JSON.stringify({
        ts: '2026-08-04T10:02:00.000Z',
        type: 'forbidden_access',
        metadata: { userId: 'u-1', farmId: 'farm-1' },
      }),
      JSON.stringify({
        ts: '2026-08-04T10:03:00.000Z',
        type: 'failed_login',
        metadata: { email: 'x@y.z', reason: 'unknown_email' },
      }),
      JSON.stringify({
        ts: '2026-08-04T10:04:00.000Z',
        type: 'logout',
        metadata: { email: 'owner@trovara.farm' },
      }),
      '',
      'not-json',
    ]

    expect(selectSecurityDashboardEvents(lines, 10)).toEqual([
      {
        ts: '2026-08-04T10:04:00.000Z',
        type: 'logout',
        metadata: { email: 'owner@trovara.farm' },
      },
      {
        ts: '2026-08-04T10:03:00.000Z',
        type: 'failed_login',
        metadata: { email: 'x@y.z', reason: 'unknown_email' },
      },
      {
        ts: '2026-08-04T10:00:00.000Z',
        type: 'login',
        metadata: { email: 'owner@trovara.farm' },
      },
    ])
  })

  it('respects the limit while scanning past hidden events', () => {
    const lines = [
      JSON.stringify({ ts: '2026-08-04T09:00:00.000Z', type: 'login', metadata: {} }),
      JSON.stringify({ ts: '2026-08-04T09:01:00.000Z', type: 'csrf_failure', metadata: {} }),
      JSON.stringify({ ts: '2026-08-04T09:02:00.000Z', type: 'password_changed', metadata: {} }),
    ]
    expect(selectSecurityDashboardEvents(lines, 1)).toEqual([
      { ts: '2026-08-04T09:02:00.000Z', type: 'password_changed', metadata: {} },
    ])
  })
})
