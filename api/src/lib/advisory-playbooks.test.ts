import { describe, expect, it } from 'vitest'
import {
  cropRulesForCycle,
  daysBetween,
  dueRulesForDay,
  isRuleDue,
  isWithinOffsetWindow,
  type AdvisableCropCycle,
  type AdvisoryRuleDef,
  type CropCycleTaskEntry,
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

describe('rules from a crop cycle plan', () => {
  const vegetative: AdvisableCropCycle = { cropType: 'plantain', stage: 'vegetative' }

  function task(over: Partial<CropCycleTaskEntry> = {}): CropCycleTaskEntry {
    return {
      stage: 'vegetative',
      offsetDays: 18,
      templateName: 'Row mulching',
      description: null,
      translationStatus: 'done',
      ...over,
    }
  }

  it('keys a rule by stage, day and subject, never by anything a regeneration remints', () => {
    const [rule] = cropRulesForCycle(vegetative, [task()])

    expect(rule.ruleKey).toBe('crop.plan.vegetative.d18.row-mulching')
    // Regenerating the same work must produce the same key, or the farm is told
    // its whole plan a second time.
    expect(cropRulesForCycle(vegetative, [task()])[0].ruleKey).toBe(rule.ruleKey)
    // A moved date and a renamed task are genuinely new things to say.
    expect(cropRulesForCycle(vegetative, [task({ offsetDays: 30 })])[0].ruleKey).not.toBe(
      rule.ruleKey,
    )
    expect(cropRulesForCycle(vegetative, [task({ templateName: 'Ring weeding' })])[0].ruleKey)
      .not.toBe(rule.ruleKey)
  })

  it('borrows its framing from a rule of the same stage', () => {
    const [planted] = cropRulesForCycle({ cropType: 'plantain', stage: 'planted' }, [
      task({ stage: 'planted', offsetDays: 2 }),
    ])
    expect(planted.reasonCode).toBe('crop_stage_planted')

    const [harvest] = cropRulesForCycle({ cropType: 'plantain', stage: 'harvest_ready' }, [
      task({ stage: 'harvest_ready', offsetDays: 5 }),
    ])
    expect(harvest.reasonCode).toBe('crop_stage_harvest_prep')
    // The roles are half of what the framing is for: harvest work has to reach
    // the people who book labour and buyers.
    expect(harvest.notifyRoles).toEqual(['supervisor', 'owner'])
  })

  it('frames a crop the playbook does not cover without naming another crop', () => {
    const [rule] = cropRulesForCycle({ cropType: 'cassava', stage: 'vegetative' }, [task()])

    expect(rule.reasonCode).toBe('crop_stage_mulch')
    expect(rule.needQuery).toBe('Row mulching cassava farm')
    expect(`${rule.happeningNow} ${rule.whatNext} ${rule.needQuery}`).not.toMatch(
      /plantain|coconut/i,
    )
  })

  it('falls back to the playbook only for a cycle with no plan at all', () => {
    expect(cropRulesForCycle(vegetative, []).map((rule) => rule.ruleKey)).toEqual([
      'plantain.vegetative.mulch',
      'plantain.vegetative.fertilize',
    ])
    // A plan that says nothing about this stage says nothing is scheduled here.
    expect(cropRulesForCycle(vegetative, [task({ stage: 'flowering' })])).toEqual([])
  })
})
