import { describe, expect, it } from 'vitest'
import { COST_CENTRES, COST_CENTRE_CODES, isCostCentreCode } from './cost-centres.js'

describe('cost-centre catalogue', () => {
  it('keeps the catalogue and validation codes unique and in sync', () => {
    expect(COST_CENTRES.map(({ code }) => code)).toEqual([...COST_CENTRE_CODES])
    expect(new Set(COST_CENTRE_CODES).size).toBe(COST_CENTRE_CODES.length)
  })

  it.each(['CC02', 'CC03', 'CC04'])('accepts %s for writes and filters', (code) => {
    expect(isCostCentreCode(code)).toBe(true)
  })

  it('retains every existing code and rejects unknown codes', () => {
    for (const code of ['CC01', 'CC10', 'CC20', 'CC30', 'CC40', 'CC50', 'CC60', 'CC70', 'CC80']) {
      expect(isCostCentreCode(code)).toBe(true)
    }
    expect(isCostCentreCode('CC99')).toBe(false)
    expect(isCostCentreCode('CC-02')).toBe(false) // Imports normalize; API writes use canonical codes.
  })
})
