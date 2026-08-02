import { describe, expect, it } from 'vitest'
import { EXPLAINED_OUT_REASONS, MOVEMENT_REASON_SENTINELS } from './inventory-stock.js'

describe('inventory stock sentinels', () => {
  it('includes sale, harvest_in and spoilage as machine reasons', () => {
    expect(MOVEMENT_REASON_SENTINELS.has('sale')).toBe(true)
    expect(MOVEMENT_REASON_SENTINELS.has('harvest_in')).toBe(true)
    expect(MOVEMENT_REASON_SENTINELS.has('spoilage')).toBe(true)
    expect(MOVEMENT_REASON_SENTINELS.has('goods_receipt')).toBe(true)
  })

  it('treats sale, task usage and spoilage as explained outs', () => {
    expect(EXPLAINED_OUT_REASONS.has('sale')).toBe(true)
    expect(EXPLAINED_OUT_REASONS.has('task_consumption')).toBe(true)
    expect(EXPLAINED_OUT_REASONS.has('spoilage')).toBe(true)
    expect(EXPLAINED_OUT_REASONS.has('opening_stock_count')).toBe(false)
  })
})
