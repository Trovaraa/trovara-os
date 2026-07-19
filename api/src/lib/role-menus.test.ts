import { describe, expect, it } from 'vitest'
import { roleCommandHelp, telegramCommandsForRole } from './role-menus.js'

describe('telegramCommandsForRole', () => {
  it('field worker menu excludes approve and clock is present', () => {
    const cmds = telegramCommandsForRole('field_worker').map((c) => c.command)
    expect(cmds).toContain('clockin')
    expect(cmds).toContain('done')
    expect(cmds).not.toContain('approve')
    expect(cmds).not.toContain('confirm')
  })

  it('admin menu excludes clock-in', () => {
    const cmds = telegramCommandsForRole('owner').map((c) => c.command)
    expect(cmds).toContain('approve')
    expect(cmds).toContain('orders')
    expect(cmds).not.toContain('clockin')
    expect(cmds).not.toContain('clockout')
  })

  it('sales menu is order-focused', () => {
    const cmds = telegramCommandsForRole('sales').map((c) => c.command)
    expect(cmds).toContain('confirm')
    expect(cmds).toContain('printqr')
    expect(cmds).not.toContain('clockin')
    expect(cmds).not.toContain('approve')
  })
})

describe('roleCommandHelp', () => {
  it('does not mention clock-in for admin', () => {
    const help = roleCommandHelp('en', 'owner')
    expect(help).toMatch(/admin/i)
    expect(help).not.toMatch(/clockin/i)
    expect(help).toMatch(/Crop:/)
  })

  it('field help includes clock-in and not order confirm', () => {
    const help = roleCommandHelp('en', 'field_worker')
    expect(help).toMatch(/clockin/i)
    expect(help).not.toMatch(/\/confirm/)
  })
})
