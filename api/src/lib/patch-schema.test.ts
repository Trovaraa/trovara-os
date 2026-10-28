import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { patchSchema } from './patch-schema.js'
import { updateAssetSchema } from '../routes/assets.js'
import { updateItemSchema } from '../routes/inventory.js'
import { updateProductSchema } from '../routes/products.js'
import { patchPostSchema as careerPatch } from '../routes/careers.js'
import { patchPostSchema as journalPatch } from '../routes/journal.js'
import { engagementUpdateSchema } from '../routes/contractors.js'

describe('Zod 4 migration preserves partial updates', () => {
  it.each([
    ['asset', updateAssetSchema, { name: 'Updated tractor' }],
    ['stock item', updateItemSchema, { name: 'Updated seed' }],
    ['product', updateProductSchema, { name: 'Updated produce' }],
    ['career', careerPatch, { published: true }],
    ['journal', journalPatch, { published: false }],
    ['engagement', engagementUpdateSchema, { status: 'completed' }],
  ] as const)('does not reset omitted %s fields to create defaults', (_name, schema, update) => {
    expect(schema.parse(update)).toEqual(update)
  })
  it('still rejects empty content patches and invalid explicit values', () => {
    expect(careerPatch.safeParse({}).success).toBe(false)
    expect(journalPatch.safeParse({}).success).toBe(false)
    expect(updateProductSchema.safeParse({ priceKobo: -1 }).success).toBe(false)
    expect(updateAssetSchema.safeParse({ quantityOwned: '3' }).success).toBe(false)
    expect(engagementUpdateSchema.safeParse({ status: 'invalid' }).success).toBe(false)
  })
  it('preserves explicit zero, false, null and transforms without applying omitted defaults', () => {
    const create = z.object({
      amount: z.number().default(10), active: z.boolean().default(true),
      note: z.string().trim().nullable().default('default'),
      slug: z.string().default('default').transform(value => value.toLowerCase()),
    })
    expect(create.parse({})).toEqual({ amount: 10, active: true, note: 'default', slug: 'default' })
    expect(patchSchema(create).parse({})).toEqual({})
    expect(patchSchema(create).parse({ amount: 0, active: false, note: null, slug: 'FIELD' }))
      .toEqual({ amount: 0, active: false, note: null, slug: 'field' })
  })
  it('rejects an oversized constrained collection before accumulating per-item errors', () => {
    const result = z.array(z.number()).max(20).safeParse(Array(5000).fill('invalid'))
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1)
      expect(result.error.issues[0].code).toBe('too_big')
    }
  })
})
