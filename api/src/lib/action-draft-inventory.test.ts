import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Inventory rows the fake db returns, set per test. */
let itemRows: Record<string, unknown>[] = []

/** Values passed to the inventory_movements insert. */
const movements: Record<string, unknown>[] = []

const tx = {
  insert: () => ({
    values: async (values: Record<string, unknown>) => {
      movements.push(values)
    },
  }),
  update: () => ({
    set: () => ({
      where: () => ({
        returning: async () => [{ id: 'item-1', name: 'Feed', quantity: 45, unit: 'kg' }],
      }),
    }),
  }),
}

vi.mock('../db/index.js', () => {
  const selectChain = () => {
    const self: Record<string, unknown> = {}
    const same = () => self
    Object.assign(self, {
      from: same,
      where: same,
      limit: same,
      then: (resolve: (rows: Record<string, unknown>[]) => unknown, reject?: unknown) =>
        Promise.resolve(itemRows).then(resolve, reject as never),
    })
    return self
  }
  return {
    db: {
      select: selectChain,
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  }
})

vi.mock('./audit.js', () => ({ logAudit: vi.fn(async () => undefined) }))

async function resolve(query: string) {
  const { resolveInventoryItemByName } = await import('./action-draft-inventory.js')
  return resolveInventoryItemByName('farm-1', query)
}

function item(id: string, name: string) {
  return { id, name, quantity: 40, reorderLevel: 10, unit: 'kg' }
}

describe('resolveInventoryItemByName', () => {
  beforeEach(() => {
    itemRows = [item('item-1', 'Engrais NPK'), item('item-2', 'Maïs-Grain'), item('item-3', 'Feed')]
  })

  it('matches an item typed without its diacritics', async () => {
    await expect(resolve('engrais npk')).resolves.toMatchObject({ id: 'item-1' })
    await expect(resolve('mais grain')).resolves.toMatchObject({ id: 'item-2' })
  })

  it('matches through case and stray whitespace', async () => {
    await expect(resolve('  FEED ')).resolves.toMatchObject({ id: 'item-3' })
    await expect(resolve('Engrais   NPK')).resolves.toMatchObject({ id: 'item-1' })
  })

  it('hands back the stored name and numbers untouched', async () => {
    await expect(resolve('mais grain')).resolves.toMatchObject({
      name: 'Maïs-Grain',
      quantity: 40,
      reorderLevel: 10,
      unit: 'kg',
    })
  })

  it('misses an item the farm does not stock', async () => {
    await expect(resolve('Engrais NPK 20')).resolves.toBeNull()
    await expect(resolve('')).resolves.toBeNull()
  })

  it('refuses to guess between two items that fold together', async () => {
    itemRows = [item('item-1', 'Maïs-Grain'), item('item-2', 'Mais Grain')]

    await expect(resolve('mais grain')).resolves.toBeNull()
    // Either item is still reachable by its own exact name.
    await expect(resolve('Maïs-Grain')).resolves.toMatchObject({ id: 'item-1' })
    await expect(resolve('Mais Grain')).resolves.toMatchObject({ id: 'item-2' })
  })
})

describe('executeConfirmedStockMove', () => {
  const manager = {
    id: 'user-1',
    farmId: 'farm-1',
    email: 'sup@farm.test',
    name: 'Supervisor',
    role: 'supervisor' as const,
    mustChangePassword: false,
  }

  beforeEach(() => {
    movements.length = 0
    itemRows = [{ id: 'item-1', farmId: 'farm-1', name: 'Feed', quantity: 40, unit: 'kg' }]
  })

  async function move(locale?: { sourceLocale: string | null; translationStatus: string }) {
    const { executeConfirmedStockMove } = await import('./action-draft-inventory.js')
    return executeConfirmedStockMove(
      manager,
      { itemId: 'item-1', delta: 5, reason: 'sacs mouilles' },
      'butler',
      locale as never,
    )
  }

  it('carries a draft the translator could not finish through to the movement row', async () => {
    await move({ sourceLocale: 'fr', translationStatus: 'pending' })

    expect(movements[0]).toMatchObject({
      reason: 'sacs mouilles',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('records the author locale of a draft that translated cleanly', async () => {
    await move({ sourceLocale: 'fr', translationStatus: 'done' })

    expect(movements[0]).toMatchObject({ sourceLocale: 'fr', translationStatus: 'done' })
  })

  it('leaves the columns alone for a reason that was English to begin with', async () => {
    await move({ sourceLocale: null, translationStatus: 'done' })

    expect(movements[0]).not.toHaveProperty('sourceLocale')
    expect(movements[0]).not.toHaveProperty('translationStatus')
  })
})
