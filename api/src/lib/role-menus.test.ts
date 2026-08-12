import { describe, expect, it } from 'vitest'
import { roleCommandHelp, telegramCommandsForRole } from './role-menus.js'

describe('telegramCommandsForRole', () => {
  it.each(['owner', 'supervisor', 'sales', 'field_worker'] as const)(
    '%s menu includes both attendance commands',
    (role) => {
      const cmds = telegramCommandsForRole(role).map((c) => c.command)
      expect(cmds).toContain('clockin')
      expect(cmds).toContain('clockout')
    },
  )

  it('field worker menu excludes manager and order actions', () => {
    const cmds = telegramCommandsForRole('field_worker').map((c) => c.command)
    expect(cmds).toContain('done')
    expect(cmds).not.toContain('approve')
    expect(cmds).not.toContain('confirm')
  })

  it('sales menu is order-focused', () => {
    const cmds = telegramCommandsForRole('sales').map((c) => c.command)
    expect(cmds).toContain('confirm')
    expect(cmds).toContain('printqr')
    expect(cmds).not.toContain('approve')
  })
})

describe('roleCommandHelp', () => {
  it.each(['owner', 'supervisor', 'sales', 'field_worker'] as const)(
    '%s help includes clock-in and clock-out',
    (role) => {
      const help = roleCommandHelp('en', role)
      expect(help).toMatch(/\/clockin/i)
      expect(help).toMatch(/\/clockout/i)
    },
  )

  it('field help includes clock-in and not order confirm', () => {
    const help = roleCommandHelp('en', 'field_worker')
    expect(help).toMatch(/clockin/i)
    expect(help).not.toMatch(/\/confirm/)
  })
})
