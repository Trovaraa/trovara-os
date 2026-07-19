import { describe, expect, it } from 'vitest'
import {
  allocateLotCode,
  buildLotCodeBase,
  harvestPeriodFromHour,
  normalizeLotUnit,
} from './lot-codes.js'

describe('harvestPeriodFromHour', () => {
  it('maps morning afternoon evening', () => {
    expect(harvestPeriodFromHour(5)).toBe('001')
    expect(harvestPeriodFromHour(11)).toBe('001')
    expect(harvestPeriodFromHour(12)).toBe('002')
    expect(harvestPeriodFromHour(16)).toBe('002')
    expect(harvestPeriodFromHour(17)).toBe('003')
    expect(harvestPeriodFromHour(0)).toBe('003')
    expect(harvestPeriodFromHour(4)).toBe('003')
  })
})

describe('buildLotCodeBase', () => {
  it('uses order reference + period', () => {
    expect(buildLotCodeBase({ orderReference: 'TRV-ORD-8FKD12', period: '001' })).toBe(
      'TRV-ORD-8FKD12-001',
    )
  })

  it('builds standalone codes with date', () => {
    const code = buildLotCodeBase({
      period: '002',
      when: new Date('2026-07-18T14:00:00Z'),
      timeZone: 'UTC',
    })
    expect(code).toBe('LOT-20260718-002')
  })
})

describe('allocateLotCode', () => {
  it('returns base when free', () => {
    expect(allocateLotCode('TRV-ORD-AAAAAA-001', [])).toBe('TRV-ORD-AAAAAA-001')
  })

  it('suffixes on collision', () => {
    expect(allocateLotCode('TRV-ORD-AAAAAA-001', ['TRV-ORD-AAAAAA-001'])).toBe(
      'TRV-ORD-AAAAAA-001-2',
    )
    expect(
      allocateLotCode('TRV-ORD-AAAAAA-001', ['TRV-ORD-AAAAAA-001', 'TRV-ORD-AAAAAA-001-2']),
    ).toBe('TRV-ORD-AAAAAA-001-3')
  })
})

describe('normalizeLotUnit', () => {
  it('maps crate synonyms to crates', () => {
    expect(normalizeLotUnit('crate')).toBe('crates')
    expect(normalizeLotUnit('Crates')).toBe('crates')
    expect(normalizeLotUnit('kg')).toBe('kg')
    expect(normalizeLotUnit('bag')).toBe('kg')
  })
})
