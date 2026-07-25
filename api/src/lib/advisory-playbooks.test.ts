import { describe, expect, it } from 'vitest'
import {
  daysBetween,
  dueRulesForDay,
  isRuleDue,
  isWithinOffsetWindow,
  type AdvisoryRuleDef,
} from './advisory-playbooks.js'

describe('advisory-playbooks windows', () => {
  it('computes whole days between dates', () => {
    const from = new Date('2026-07-01T10:00:00Z')
    const to = new Date('2026-07-08T09:00:00Z')
    expect(daysBetween(from, to)).toBe(6)
  })

  it('matches offset within ±1 day by default', () => {
    expect(isWithinOffsetWindow(7, 7)).toBe(true)
    expect(isWithinOffsetWindow(6, 7)).toBe(true)
    expect(isWithinOffsetWindow(8, 7)).toBe(true)
    expect(isWithinOffsetWindow(4, 7)).toBe(false)
  })

  it('treats mid-cycle days as due with overdue grace', () => {
    expect(isRuleDue(17, 14)).toBe(true)
    expect(isRuleDue(17, 21, { earlyDays: 5 })).toBe(true)
    expect(isRuleDue(17, 28)).toBe(false)
  })

  it('falls back to latest past rule when far past all windows', () => {
    const rules: AdvisoryRuleDef[] = [
      {
        ruleKey: 'a',
        offsetDays: 14,
        happeningNow: 'a',
        whatNext: 'a',
        needQuery: 'organic compost',
        notifyRoles: ['field_worker'],
        reasonCode: 'a',
      },
      {
        ruleKey: 'b',
        offsetDays: 45,
        happeningNow: 'b',
        whatNext: 'b',
        needQuery: 'organic compost',
        notifyRoles: ['field_worker'],
        reasonCode: 'b',
      },
    ]
    const due = dueRulesForDay(120, rules)
    expect(due.map((r) => r.ruleKey)).toEqual(['b'])
  })
})
