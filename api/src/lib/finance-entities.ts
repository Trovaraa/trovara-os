export const FINANCE_ENTITIES = [
  {
    code: '001',
    name: 'Green Frontier',
    relationship: 'parent',
    parentCode: null,
  },
  {
    code: '002',
    name: 'Trovara',
    relationship: 'child',
    parentCode: '001',
  },
] as const

export const FINANCE_ENTITY_CODES = FINANCE_ENTITIES.map((entity) => entity.code) as [
  '001',
  '002',
]

export type FinanceEntityCode = (typeof FINANCE_ENTITY_CODES)[number]

export const DEFAULT_FINANCE_ENTITY_CODE: FinanceEntityCode = '002'

export function isFinanceEntityCode(value: string): value is FinanceEntityCode {
  return FINANCE_ENTITY_CODES.includes(value as FinanceEntityCode)
}

