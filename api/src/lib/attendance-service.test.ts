import { describe, expect, it } from 'vitest'
import { attendanceLabourCostNgn, payableMinutes } from './attendance-service.js'

describe('attendance payable calculations', () => {
  it('uses only whole nonnegative payable minutes', () => {
    const start = new Date('2026-07-17T07:00:00.000Z')
    expect(payableMinutes(start, new Date('2026-07-17T15:00:59.000Z'))).toBe(480)
    expect(payableMinutes(start, new Date('2026-07-17T06:00:00.000Z'))).toBe(0)
  })

  it('prorates the clock-in wage snapshot over 22 eight-hour days', () => {
    expect(attendanceLabourCostNgn(220_000, 8 * 60)).toBe(10_000)
    expect(attendanceLabourCostNgn(220_000, 4 * 60)).toBe(5_000)
  })

  it('does not produce negative labour costs', () => {
    expect(attendanceLabourCostNgn(-1, 60)).toBe(0)
    expect(attendanceLabourCostNgn(100_000, -60)).toBe(0)
  })
})
