import { describe, expect, it } from 'vitest'
import { parseCropCycleIntent, parseLivestockBatchIntent } from './action-draft-farm-parse.js'

/**
 * The species and crop lexicons are full of multi-word aliases, and the butler
 * is where field workers type them, so a value has to be allowed to run to
 * several words without swallowing the key that follows it.
 */
describe('parseLivestockBatchIntent - multi-word species', () => {
  it('parses a multi-word species and the head count after it', () => {
    expect(
      parseLivestockBatchIntent('Livestock: Noiler A species=poulet a double fin heads=200'),
    ).toMatchObject({
      name: 'Noiler A',
      species: 'poulet a double fin',
      headCount: 200,
    })
  })

  it('keeps every other key on the line out of the species', () => {
    expect(
      parseLivestockBatchIntent(
        'Batch: Pondeuses species=poule pondeuse heads=45 plot=Block 2 acquired=2026-06-01',
      ),
    ).toEqual({
      name: 'Pondeuses',
      species: 'poule pondeuse',
      headCount: 45,
      plotName: 'Block 2',
      acquiredAt: '2026-06-01',
    })
  })

  it('still parses the single-token form the menus document', () => {
    expect(
      parseLivestockBatchIntent('Livestock: Noiler A species=noiler heads=200'),
    ).toMatchObject({
      name: 'Noiler A',
      species: 'noiler',
      headCount: 200,
    })
  })

  it('captures no trailing whitespace', () => {
    expect(
      parseLivestockBatchIntent('Livestock: Noiler A species=poulet noiler   heads=200   '),
    ).toMatchObject({ species: 'poulet noiler', headCount: 200 })
  })

  it('still rejects a line with no head count', () => {
    expect(parseLivestockBatchIntent('Livestock: Noiler A species=poulet noiler')).toBeNull()
  })
})

describe('parseCropCycleIntent - multi-word crop type', () => {
  it('parses a multi-word crop type and the planting date after it', () => {
    expect(parseCropCycleIntent('Crop: Block 2 type=noix de coco planted=2026-07-19')).toEqual({
      plotName: 'Block 2',
      cropType: 'noix de coco',
      plantedAt: '2026-07-19',
      expectedHarvestAt: undefined,
      expectedYieldKg: undefined,
    })
  })

  it('keeps the harvest date and yield out of the crop type', () => {
    expect(
      parseCropCycleIntent(
        'Create crop cycle: North Field type=banane plantain planted=2026-01-01 harvest=2026-04-01 yield=800',
      ),
    ).toEqual({
      plotName: 'North Field',
      cropType: 'banane plantain',
      plantedAt: '2026-01-01',
      expectedHarvestAt: '2026-04-01',
      expectedYieldKg: 800,
    })
  })

  it('still parses the single-token form the menus document', () => {
    expect(parseCropCycleIntent('Crop: Block 2 type=plantain planted=2026-07-19')).toMatchObject({
      plotName: 'Block 2',
      cropType: 'plantain',
      plantedAt: '2026-07-19',
    })
  })

  it('captures no trailing whitespace', () => {
    expect(
      parseCropCycleIntent('Crop: Block 2 type=noix de coco    planted=2026-07-19'),
    ).toMatchObject({ cropType: 'noix de coco', plantedAt: '2026-07-19' })
  })

  it('still rejects a line with no planting date', () => {
    expect(parseCropCycleIntent('Crop: Block 2 type=noix de coco')).toBeNull()
  })
})
