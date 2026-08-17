import { describe, expect, it } from 'vitest'
import { detectObservationCandidates } from './anomaly-observations.js'

const now = new Date('2026-08-15T12:00:00.000Z')

describe('anomaly observation rules', () => {
  it('records evidence-backed inventory variance without making an accusation', () => {
    const results = detectObservationCandidates({
      reconciliation: [{ id: 'a1', itemId: '00000000-0000-4000-8000-000000000001', sku: 'FERT-01', expectedQuantity: 20, countedQuantity: 12, variance: -8, tolerance: 2 }],
      shrink: [], expenses: [], repairs: [], now,
    })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ observationType: 'inventory_variance', confidence: 95, sourceRule: 'verified_count_outside_tolerance_v1' })
    expect(results[0].title.toLowerCase()).toContain('possible')
    expect(results[0].summary.toLowerCase()).not.toMatch(/theft|fraud|stole/)
  })

  it('does not call an expense unusual without five earlier matching records', () => {
    const expense = (id: string, amount: number, day: number) => ({ id, category: 'feed', costCentreCode: 'CC40', description: 'Feed', amount, currency: 'NGN', expenseDate: new Date(`2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`) })
    const results = detectObservationCandidates({
      reconciliation: [], shrink: [], repairs: [], now,
      expenses: [expense('current', 900_000, 14), expense('1', 100_000, 1), expense('2', 110_000, 2), expense('3', 90_000, 3), expense('4', 105_000, 4)],
    })
    expect(results).toHaveLength(0)
  })

  it('flags a material expense only after a sufficient same-group baseline', () => {
    const expense = (id: string, amount: number, day: number) => ({ id, category: 'feed', costCentreCode: 'CC40', description: 'Feed', amount, currency: 'NGN', expenseDate: new Date(`2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`) })
    const results = detectObservationCandidates({
      reconciliation: [], shrink: [], repairs: [], now,
      expenses: [expense('current', 900_000, 14), expense('1', 100_000, 1), expense('2', 110_000, 2), expense('3', 90_000, 3), expense('4', 105_000, 4), expense('5', 95_000, 5)],
    })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ observationType: 'expense_outlier', entityId: 'current' })
    expect(results[0].evidence).toMatchObject({ peerCount: 5, baselineMedian: 100_000 })
  })

  it('records repeat repairs as a review signal, not a replacement decision', () => {
    const results = detectObservationCandidates({
      reconciliation: [], shrink: [], expenses: [], now,
      repairs: [
        { id: 'r1', assetId: '00000000-0000-4000-8000-000000000002', assetName: 'Water pump', completedAt: new Date('2026-07-01'), actualCostMinor: 100_000 },
        { id: 'r2', assetId: '00000000-0000-4000-8000-000000000002', assetName: 'Water pump', completedAt: new Date('2026-08-01'), actualCostMinor: 150_000 },
      ],
    })
    expect(results[0]).toMatchObject({ observationType: 'repeat_repair', confidence: 72 })
    expect(results[0].summary).toContain('Review the work orders')
  })
})
