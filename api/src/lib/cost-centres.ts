export const COST_CENTRE_CODES = [
  'CC01',
  'CC10',
  'CC20',
  'CC30',
  'CC40',
  'CC50',
  'CC60',
  'CC70',
  'CC80',
] as const

export type CostCentreCode = (typeof COST_CENTRE_CODES)[number]

export const COST_CENTRES: ReadonlyArray<{
  code: CostCentreCode
  name: string
  covers: string
}> = [
  { code: 'CC01', name: 'Corporate / Admin', covers: 'General Trovara overhead' },
  { code: 'CC10', name: 'Plantain', covers: 'Plantain production' },
  { code: 'CC20', name: 'Coconut', covers: 'Coconut estate' },
  { code: 'CC30', name: 'Oil Palm', covers: 'Oil palm estate' },
  { code: 'CC40', name: 'Poultry', covers: 'Project Feather' },
  { code: 'CC50', name: 'Nursery & Trees', covers: 'Project Canopy' },
  { code: 'CC60', name: 'Processing', covers: 'Trovara Harvest / processing operations' },
  {
    code: 'CC70',
    name: 'Trading & Sourcing',
    covers: 'Produce bought from external farmers',
  },
  {
    code: 'CC80',
    name: 'Sales & Distribution',
    covers: 'Customer fulfilment and general selling',
  },
]

export function isCostCentreCode(value: string): value is CostCentreCode {
  return (COST_CENTRE_CODES as readonly string[]).includes(value)
}
