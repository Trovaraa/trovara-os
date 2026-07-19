import { describe, expect, it } from 'vitest'
import { parseCropCycleIntent, parseLivestockBatchIntent } from './action-draft-farm-parse.js'

describe('parseCropCycleIntent', () => {
  it('parses crop draft lines', () => {
    expect(parseCropCycleIntent('Crop: Block 2 type=plantain planted=2026-07-19')).toEqual({
      plotName: 'Block 2',
      cropType: 'plantain',
      plantedAt: '2026-07-19',
      expectedHarvestAt: undefined,
      expectedYieldKg: undefined,
    })
    expect(
      parseCropCycleIntent(
        'Create crop: North Field type=tomato planted=2026-01-01 harvest=2026-04-01 yield=800',
      ),
    ).toMatchObject({
      plotName: 'North Field',
      cropType: 'tomato',
      expectedYieldKg: 800,
    })
  })
})

describe('parseLivestockBatchIntent', () => {
  it('parses livestock draft lines', () => {
    expect(
      parseLivestockBatchIntent('Livestock: Broiler A species=broiler heads=200'),
    ).toMatchObject({
      name: 'Broiler A',
      species: 'broiler',
      headCount: 200,
    })
    expect(
      parseLivestockBatchIntent(
        'Batch: Goats species=goat heads=12 plot=Block 1 acquired=2026-06-01',
      ),
    ).toMatchObject({
      name: 'Goats',
      plotName: 'Block 1',
      acquiredAt: '2026-06-01',
    })
  })
})
