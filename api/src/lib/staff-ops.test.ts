import { describe, expect, it } from 'vitest'
import { parseStaffOpsCommand, taskReference } from './staff-ops.js'

describe('parseStaffOpsCommand', () => {
  it('parses clock and task commands', () => {
    expect(parseStaffOpsCommand('/clockin')).toEqual({ action: 'clock_in' })
    expect(parseStaffOpsCommand('clock out')).toEqual({ action: 'clock_out' })
    expect(parseStaffOpsCommand('/tasks')).toEqual({ action: 'tasks' })
    expect(parseStaffOpsCommand('/taskstart')).toEqual({ action: 'start' })
    expect(parseStaffOpsCommand('/done TSK-ABCDEF weeded plot')).toEqual({
      action: 'done',
      ref: 'TSK-ABCDEF',
      note: 'weeded plot',
    })
    expect(parseStaffOpsCommand('/approve')).toEqual({ action: 'approve' })
    expect(parseStaffOpsCommand('/start')).toEqual({ action: 'help' })
  })
})

describe('taskReference', () => {
  it('builds short task refs', () => {
    expect(taskReference('abcdef12-3456-7890-abcd-ef1234567890')).toBe('TSK-ABCDEF')
  })
})
