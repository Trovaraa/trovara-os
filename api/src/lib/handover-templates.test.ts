import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const nameOf = (table: unknown) => getTableName(table as never)

/** Rows the fake db returns, queued per table so query order does not matter. */
const selectQueue = new Map<string, Row[][]>()
const selectLog: string[] = []
const inserted: { table: string; values: Row }[] = []

function queueSelect(table: string, rows: Row[], times = 1) {
  const queued = selectQueue.get(table) ?? []
  for (let i = 0; i < times; i += 1) queued.push(rows)
  selectQueue.set(table, queued)
}

vi.mock('../db/index.js', () => {
  const selectChain = () => {
    let rows: Row[] = []
    const self: Record<string, unknown> = {}
    const same = () => self
    Object.assign(self, {
      from: (table: unknown) => {
        const name = nameOf(table)
        selectLog.push(name)
        rows = selectQueue.get(name)?.shift() ?? []
        return self
      },
      leftJoin: same,
      innerJoin: same,
      where: same,
      orderBy: same,
      limit: same,
      then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    })
    return self
  }

  return {
    db: {
      select: selectChain,
      insert: (table: unknown) => ({
        values: (values: Row) => {
          const name = nameOf(table)
          inserted.push({ table: name, values })
          return {
            returning: async () => [{ id: `${name}-new`, ...values }],
            onConflictDoNothing: async () => undefined,
          }
        },
      }),
    },
  }
})

const completeChat = vi.fn()
const isLlmConfigured = vi.fn(() => true)

vi.mock('./llm.js', () => ({
  completeChat: (...args: unknown[]) => completeChat(...args),
  isLlmConfigured: () => isLlmConfigured(),
}))

vi.mock('./llm-budget.js', () => ({
  checkLlmBudget: () => ({ allowed: true, used: 0, limit: 500 }),
  consumeLlmBudget: vi.fn(),
}))

/** The real content-locale service runs; the spies count entries into it. */
const canonicalCalls = vi.fn()
const viewerBatchCalls = vi.fn()

vi.mock('./content-locale.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./content-locale.js')>()
  return {
    ...actual,
    toCanonicalEnglish: (args: Parameters<typeof actual.toCanonicalEnglish>[0]) => {
      canonicalCalls(args)
      return actual.toCanonicalEnglish(args)
    },
    toViewerLocaleMany: (args: Parameters<typeof actual.toViewerLocaleMany>[0]) => {
      viewerBatchCalls(args)
      return actual.toViewerLocaleMany(args)
    },
  }
})

vi.mock('./audit.js', () => ({ logAudit: vi.fn(async () => undefined) }))

const ENGLISH_TO_FRENCH: Record<string, string> = {
  'Map and verify a zone': 'Cartographier et vérifier une zone',
  'Count crops in a block': 'Compter les cultures dans un bloc',
  'Count crops in a block: Block A': 'Compter les cultures dans un bloc : Block A',
}

const FRENCH_TO_ENGLISH: Record<string, string> = {
  'Cartographier et vérifier une zone': 'Map and verify a zone',
}

const owner = {
  id: 'user-owner',
  farmId: 'farm-1',
  role: 'owner' as const,
  name: 'Owner',
  email: 'owner@trovara.farm',
}

/** A `task_templates` row as `generateHandoverTasks` reads it back. */
function templateRow(overrides: Row = {}): Row {
  return {
    id: 'tpl-zone-map',
    farmId: 'farm-1',
    name: 'Map and verify a zone',
    description: 'Walk the zone boundary, confirm name/location, and note access points.',
    cropType: null,
    checklist: null,
    defaultDurationHours: null,
    actionType: 'zone_map',
    systemTemplateKey: 'handover_zone_map',
    defaultPayload: {},
    sourceLocale: 'en',
    translationStatus: 'done',
    createdAt: new Date('2026-07-01T08:00:00Z'),
    ...overrides,
  }
}

/** Skip the seeding inserts: every system template already exists. */
function templatesAlreadySeeded() {
  queueSelect('task_templates', [{ id: 'tpl-existing' }], 7)
}

function insertedTasks(): Row[] {
  return inserted.filter((entry) => entry.table === 'tasks').map((entry) => entry.values)
}

async function generate(input: Parameters<
  typeof import('./handover-templates.js')['generateHandoverTasks']
>[1]) {
  const { generateHandoverTasks } = await import('./handover-templates.js')
  return generateHandoverTasks(owner, input)
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.clear()
  selectLog.length = 0
  inserted.length = 0
  isLlmConfigured.mockReturnValue(true)
  completeChat.mockImplementation(async (system: string, text: string) => {
    const table = /into English/i.test(system) ? FRENCH_TO_ENGLISH : ENGLISH_TO_FRENCH
    return { text: table[text] ?? `[${text}]`, model: 'test' }
  })
})

describe('seedHandoverTemplates', () => {
  it('labels the built-in English templates so generation can trust them', async () => {
    const { seedHandoverTemplates, HANDOVER_TEMPLATES } = await import('./handover-templates.js')

    const created = await seedHandoverTemplates('farm-1')

    expect(created).toBe(HANDOVER_TEMPLATES.length)
    const rows = inserted.filter((entry) => entry.table === 'task_templates')
    expect(rows).toHaveLength(HANDOVER_TEMPLATES.length)
    for (const row of rows) {
      expect(row.values).toMatchObject({ sourceLocale: 'en' })
    }
    expect(completeChat).not.toHaveBeenCalled()
  })

  it('does not reseed a farm that already has the templates', async () => {
    templatesAlreadySeeded()
    const { seedHandoverTemplates } = await import('./handover-templates.js')

    expect(await seedHandoverTemplates('farm-1')).toBe(0)
    expect(inserted.filter((entry) => entry.table === 'task_templates')).toHaveLength(0)
  })
})

describe('generateHandoverTasks - copying template prose into tasks', () => {
  it('copies the English through with the template labels and no translation call', async () => {
    templatesAlreadySeeded()
    queueSelect('task_templates', [templateRow()])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const created = await generate({ templateKeys: ['handover_zone_map'] })

    expect(created).toHaveLength(1)
    expect(insertedTasks()[0]).toMatchObject({
      title: 'Map and verify a zone',
      description: 'Walk the zone boundary, confirm name/location, and note access points.',
      sourceLocale: 'en',
      translationStatus: 'done',
      templateId: 'tpl-zone-map',
    })
    expect(canonicalCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
  })

  it('inherits a pending template label so the retry job picks the task up', async () => {
    templatesAlreadySeeded()
    queueSelect('task_templates', [
      templateRow({
        name: 'Cartographier et vérifier une zone',
        description: null,
        sourceLocale: 'fr',
        translationStatus: 'pending',
      }),
    ])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await generate({ templateKeys: ['handover_zone_map'] })

    expect(insertedTasks()[0]).toMatchObject({
      title: 'Cartographier et vérifier une zone',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
    expect(canonicalCalls).not.toHaveBeenCalled()
  })

  it('marks the task pending when a template claiming done still holds French', async () => {
    templatesAlreadySeeded()
    queueSelect('task_templates', [
      templateRow({
        name: 'Cartographier et vérifier une zone',
        description: null,
        sourceLocale: null,
        translationStatus: 'done',
      }),
    ])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await generate({ templateKeys: ['handover_zone_map'] })

    expect(insertedTasks()[0]).toMatchObject({
      title: 'Cartographier et vérifier une zone',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
    expect(completeChat).not.toHaveBeenCalled()
  })

  it('keeps the row English when only the appended plot name is a proper noun', async () => {
    templatesAlreadySeeded()
    queueSelect('task_templates', [
      templateRow({
        id: 'tpl-census',
        name: 'Count crops in a block',
        description: null,
        actionType: 'crop_census',
        systemTemplateKey: 'handover_crop_census',
      }),
    ])
    queueSelect('plots', [{ id: 'plot-1', name: 'Block A' }])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await generate({ templateKeys: ['handover_crop_census'], plotIds: ['plot-1'] })

    expect(insertedTasks()[0]).toMatchObject({
      title: 'Count crops in a block: Block A',
      sourceLocale: 'en',
      translationStatus: 'done',
    })
  })

  it('returns the created titles in the actor language from one batched call', async () => {
    templatesAlreadySeeded()
    queueSelect('task_templates', [templateRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const created = await generate({ templateKeys: ['handover_zone_map'] })

    expect(created[0].title).toBe('Cartographier et vérifier une zone')
    expect(insertedTasks()[0].title).toBe('Map and verify a zone')
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
  })

  it('does no translation work at all for an English actor', async () => {
    templatesAlreadySeeded()
    queueSelect('task_templates', [templateRow()])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const created = await generate({ templateKeys: ['handover_zone_map'] })

    expect(created[0].title).toBe('Map and verify a zone')
    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
  })

  it('leaves the structured action payload alone', async () => {
    templatesAlreadySeeded()
    queueSelect('task_templates', [
      templateRow({
        id: 'tpl-census',
        actionType: 'crop_census',
        systemTemplateKey: 'handover_crop_census',
        defaultPayload: { crops: ['plantain', 'oil_palm', 'coconut'] },
      }),
    ])
    queueSelect('plots', [{ id: 'plot-1', name: 'Block A' }])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await generate({ templateKeys: ['handover_crop_census'], plotIds: ['plot-1'] })

    expect(insertedTasks()[0]).toMatchObject({
      actionType: 'crop_census',
      actionPayload: {
        crops: ['plantain', 'oil_palm', 'coconut'],
        systemTemplateKey: 'handover_crop_census',
      },
    })
  })
})
