import { describe, expect, it } from 'vitest'
import type { SessionUser } from './session.js'
import { aiActionCapabilities } from './ai-actions.js'

function user(role: SessionUser['role'], permissions: string[]): SessionUser {
  return {
    id: `${role}-1`,
    farmId: 'farm-1',
    email: `${role}@farm.test`,
    name: role,
    role,
    permissions: permissions as SessionUser['permissions'],
    mustChangePassword: false,
  }
}

describe('AI action capabilities', () => {
  it('never grants Sales an inventory write through AI', () => {
    const rows = aiActionCapabilities(
      user('sales', ['ai.use', 'orders.manage', 'orders.read', 'finance.read']),
    )
    expect(rows.find((row) => row.actionType === 'stock_move')?.allowed).toBe(false)
    expect(rows.find((row) => row.actionType === 'opening_count')?.allowed).toBe(false)
    expect(rows.find((row) => row.actionType === 'create_support_ticket')?.allowed).toBe(true)
  })

  it('gives a field worker only explicitly granted reporting actions', () => {
    const rows = aiActionCapabilities(
      user('field_worker', [
        'ai.use',
        'field_reports.create',
        'assets.count',
        'census.create',
        'livestock.log',
      ]),
    )
    expect(rows.find((row) => row.actionType === 'create_field_report')?.allowed).toBe(true)
    expect(rows.find((row) => row.actionType === 'asset_count')?.allowed).toBe(true)
    expect(rows.find((row) => row.actionType === 'create_task')?.allowed).toBe(false)
    expect(rows.find((row) => row.actionType === 'create_zone')?.allowed).toBe(false)
  })

  it('treats resolved empty grants as deny-all for actions', () => {
    expect(aiActionCapabilities(user('supervisor', [])).every((row) => !row.allowed)).toBe(true)
  })
})
