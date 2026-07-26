import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCreatePlotIntent, parseCreateZoneIntent } from './action-draft-zones-parse.js'
import { parseLivestockLogIntent } from './action-draft-livestock-log-parse.js'

/** Zone rows the fake db returns, set per test. */
let zoneRows: Record<string, unknown>[] = []

vi.mock('../db/index.js', () => {
  const selectChain = () => {
    const self: Record<string, unknown> = {}
    const same = () => self
    Object.assign(self, {
      from: same,
      where: same,
      limit: same,
      then: (resolve: (rows: Record<string, unknown>[]) => unknown, reject?: unknown) =>
        Promise.resolve(zoneRows).then(resolve, reject as never),
    })
    return self
  }
  return { db: { select: selectChain } }
})

describe('parseCreateZoneIntent', () => {
  it('parses zone draft lines', () => {
    expect(parseCreateZoneIntent('Create zone: North Field')).toEqual({
      name: 'North Field',
      description: undefined,
    })
    expect(
      parseCreateZoneIntent('Zone: South Pasture description=riverside paddock'),
    ).toEqual({
      name: 'South Pasture',
      description: 'riverside paddock',
    })
  })
})

describe('parseCreatePlotIntent', () => {
  it('parses plot draft lines', () => {
    expect(parseCreatePlotIntent('Create plot: Block 2 zone=North Field')).toEqual({
      name: 'Block 2',
      zoneName: 'North Field',
      cropType: undefined,
    })
    expect(
      parseCreatePlotIntent('Create plot: Block 2 zone=North Field crop=plantain'),
    ).toEqual({
      name: 'Block 2',
      zoneName: 'North Field',
      cropType: 'plantain',
    })
  })

  // A multi-word crop used to make the lazy zone group expand and swallow
  // `crop=...`, so the zone name was wrong AND the crop was dropped silently.
  it('keeps a multi-word crop out of the zone name', () => {
    expect(
      parseCreatePlotIntent('Create plot: Block 2 zone=North Field crop=noix de coco'),
    ).toEqual({
      name: 'Block 2',
      zoneName: 'North Field',
      cropType: 'noix de coco',
    })
  })
})

describe('parseLivestockLogIntent', () => {
  it('parses feed / vaccinate / mortality lines', () => {
    expect(parseLivestockLogIntent('Feed: Noiler A')).toEqual({
      logType: 'feeding',
      batchQuery: 'Noiler A',
      headCount: undefined,
      notes: undefined,
    })
    expect(parseLivestockLogIntent('Feeding: Noiler A notes=morning')).toMatchObject({
      logType: 'feeding',
      batchQuery: 'Noiler A',
      notes: 'morning',
    })
    expect(parseLivestockLogIntent('Vaccinate: Noiler A')).toMatchObject({
      logType: 'vaccination',
      batchQuery: 'Noiler A',
    })
    expect(parseLivestockLogIntent('Vaccination: Noiler A notes=day 7')).toMatchObject({
      logType: 'vaccination',
      notes: 'day 7',
    })
    expect(parseLivestockLogIntent('Mortality: Noiler A heads=3')).toEqual({
      logType: 'mortality',
      batchQuery: 'Noiler A',
      headCount: 3,
      notes: undefined,
    })
    expect(
      parseLivestockLogIntent('Mortality: Noiler A heads=3 notes=heat stress'),
    ).toMatchObject({
      logType: 'mortality',
      headCount: 3,
      notes: 'heat stress',
    })
    expect(parseLivestockLogIntent('Mortality: Noiler A')).toBeNull()
  })
})

describe('resolveZoneByName', () => {
  async function resolve(name: string) {
    const { resolveZoneByName } = await import('./action-draft-zones.js')
    return resolveZoneByName('farm-1', name)
  }

  beforeEach(() => {
    zoneRows = [
      { id: 'zone-1', name: 'Zone Nord-Est' },
      { id: 'zone-2', name: 'Pâturage' },
    ]
  })

  it('matches the zone however the worker punctuated or accented it', async () => {
    await expect(resolve('Zone Nord-Est')).resolves.toMatchObject({ id: 'zone-1' })
    await expect(resolve('zone nord est')).resolves.toMatchObject({ id: 'zone-1' })
    await expect(resolve('paturage')).resolves.toMatchObject({ id: 'zone-2' })
  })

  it('returns the stored spelling so the draft preview quotes the farm', async () => {
    await expect(resolve('paturage')).resolves.toMatchObject({ name: 'Pâturage' })
  })

  it('refuses to guess between two zones that fold together', async () => {
    zoneRows = [
      { id: 'zone-1', name: 'Zone Nord-Est' },
      { id: 'zone-2', name: 'Zone Nord Est' },
    ]

    await expect(resolve('zone nord est!')).resolves.toBeNull()
    await expect(resolve('Zone Nord-Est')).resolves.toMatchObject({ id: 'zone-1' })
  })
})
