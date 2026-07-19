import { describe, expect, it } from 'vitest'
import { parseCreatePlotIntent, parseCreateZoneIntent } from './action-draft-zones-parse.js'
import { parseLivestockLogIntent } from './action-draft-livestock-log-parse.js'

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
})

describe('parseLivestockLogIntent', () => {
  it('parses feed / vaccinate / mortality lines', () => {
    expect(parseLivestockLogIntent('Feed: Broiler A')).toEqual({
      logType: 'feeding',
      batchQuery: 'Broiler A',
      headCount: undefined,
      notes: undefined,
    })
    expect(parseLivestockLogIntent('Feeding: Broiler A notes=morning')).toMatchObject({
      logType: 'feeding',
      batchQuery: 'Broiler A',
      notes: 'morning',
    })
    expect(parseLivestockLogIntent('Vaccinate: Broiler A')).toMatchObject({
      logType: 'vaccination',
      batchQuery: 'Broiler A',
    })
    expect(parseLivestockLogIntent('Vaccination: Broiler A notes=day 7')).toMatchObject({
      logType: 'vaccination',
      notes: 'day 7',
    })
    expect(parseLivestockLogIntent('Mortality: Broiler A heads=3')).toEqual({
      logType: 'mortality',
      batchQuery: 'Broiler A',
      headCount: 3,
      notes: undefined,
    })
    expect(
      parseLivestockLogIntent('Mortality: Broiler A heads=3 notes=heat stress'),
    ).toMatchObject({
      logType: 'mortality',
      headCount: 3,
      notes: 'heat stress',
    })
    expect(parseLivestockLogIntent('Mortality: Broiler A')).toBeNull()
  })
})
