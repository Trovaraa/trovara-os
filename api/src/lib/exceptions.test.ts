import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExceptionItem } from './exceptions.js'
import type { SessionUser } from './session.js'

/**
 * `gatherExceptions` fires its nine table queries in a fixed order inside one
 * `Promise.all`, so the mock hands back queued rows in that same order. The
 * census helpers are mocked at the module boundary instead (they run two
 * queries each, which would interleave with the queue).
 */
const { resultQueue, censusRows } = vi.hoisted(() => ({
  resultQueue: [] as unknown[][],
  censusRows: {
    missing: [] as unknown[],
    rejected: [] as unknown[],
    stale: [] as unknown[],
    staleDaysArg: null as number | null,
  },
}))

function queryBuilder(rows: unknown[]) {
  const builder = {
    from: () => builder,
    leftJoin: () => builder,
    innerJoin: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    then: (onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(onFulfilled, onRejected),
  }
  return builder
}

vi.mock('../db/index.js', () => ({
  db: {
    select: () => queryBuilder(resultQueue.shift() ?? []),
    selectDistinct: () => queryBuilder(resultQueue.shift() ?? []),
  },
}))

vi.mock('./census-service.js', () => ({
  plotsMissingVerifiedCensus: async () => censusRows.missing,
  rejectedCensusSurveys: async () => censusRows.rejected,
  staleVerifiedCensus: async (_farmId: string, days: number) => {
    censusRows.staleDaysArg = days
    return censusRows.stale
  },
}))

const { gatherExceptions } = await import('./exceptions.js')

const owner: SessionUser = {
  id: 'user-1',
  farmId: 'farm-1',
  email: 'owner@trovara.farm',
  name: 'Owner',
  role: 'owner',
}

type Rows = {
  overdue?: unknown[]
  lowStock?: unknown[]
  pendingApproval?: unknown[]
  mortality?: unknown[]
  pendingOrders?: unknown[]
  rejected?: unknown[]
  activeAssets?: unknown[]
  loggedToday?: unknown[]
  pendingAssetVerification?: unknown[]
  censusMissing?: unknown[]
  censusRejected?: unknown[]
  censusStale?: unknown[]
}

function queue(rows: Rows) {
  resultQueue.push(
    rows.overdue ?? [],
    rows.lowStock ?? [],
    rows.pendingApproval ?? [],
    rows.mortality ?? [],
    rows.pendingOrders ?? [],
    rows.rejected ?? [],
    rows.activeAssets ?? [],
    rows.loggedToday ?? [],
    rows.pendingAssetVerification ?? [],
  )
  censusRows.missing = rows.censusMissing ?? []
  censusRows.rejected = rows.censusRejected ?? []
  censusRows.stale = rows.censusStale ?? []
}

const DUE = new Date('2026-07-21T22:26:15.620Z')
const VERIFIED = new Date('2026-05-02T09:00:00.000Z')

/** Every row shape the nine queries can return, so one call exercises all types. */
function allRows(): Rows {
  return {
    overdue: [
      {
        id: 'task-1',
        title: 'Spray block A',
        status: 'in_progress',
        dueDate: DUE,
        plotName: 'Block A',
        assignedToName: 'Ade',
      },
    ],
    lowStock: [
      {
        id: 'item-1',
        name: 'Urea',
        quantity: 3,
        unit: 'kg',
        reorderLevel: 10,
        category: 'fertilizer',
        updatedAt: new Date('2026-07-20T08:00:00.000Z'),
      },
    ],
    pendingApproval: [
      {
        id: 'task-2',
        title: 'Weed block B',
        updatedAt: new Date('2026-07-24T08:00:00.000Z'),
        assignedToName: 'Bola',
      },
    ],
    mortality: [
      {
        id: 'log-1',
        headCount: 4,
        notes: 'heat stress',
        createdAt: new Date('2026-07-25T06:00:00.000Z'),
        batchName: 'Noilers 12',
      },
      {
        id: 'log-2',
        headCount: 1,
        notes: null,
        createdAt: new Date('2026-07-25T07:00:00.000Z'),
        batchName: 'Layers 3',
      },
    ],
    pendingOrders: [
      {
        id: 'order-1',
        customerName: 'Mama Ngozi',
        totalAmount: 45000,
        currency: 'NGN',
        createdAt: new Date('2026-07-22T10:00:00.000Z'),
      },
    ],
    rejected: [
      {
        id: 'task-3',
        title: 'Fix fence',
        updatedAt: new Date('2026-07-23T10:00:00.000Z'),
        assignedToName: 'Chidi',
      },
    ],
    activeAssets: [{ id: 'asset-1', name: 'Tractor' }],
    loggedToday: [],
    pendingAssetVerification: [
      {
        id: 'alog-1',
        assetName: 'Generator',
        recordedByName: 'Dami',
        createdAt: new Date('2026-07-25T05:00:00.000Z'),
      },
      {
        id: 'alog-2',
        assetName: null,
        recordedByName: null,
        createdAt: new Date('2026-07-25T05:30:00.000Z'),
      },
    ],
    censusMissing: [{ id: 'plot-1', name: 'Block C' }],
    censusRejected: [
      {
        id: 'survey-1',
        plotName: 'Block D',
        cropType: 'maize',
        rejectionReason: 'blurred photo',
        createdAt: new Date('2026-07-24T12:00:00.000Z'),
      },
      {
        id: 'survey-2',
        plotName: null,
        cropType: 'cassava',
        rejectionReason: null,
        createdAt: new Date('2026-07-24T13:00:00.000Z'),
      },
    ],
    censusStale: [{ id: 'plot-2', name: 'Block E', lastVerifiedAt: VERIFIED }],
  }
}

function byType(exceptions: ExceptionItem[], type: string) {
  return exceptions.filter((e) => e.type === type)
}

beforeEach(() => {
  resultQueue.length = 0
  censusRows.staleDaysArg = null
})

describe('gatherExceptions message keys', () => {
  it('emits a key and params for every exception type', async () => {
    queue(allRows())
    const { exceptions } = await gatherExceptions(owner)

    expect(byType(exceptions, 'overdue_task')[0]).toMatchObject({
      messageKey: 'exceptions.msg.overdueSince',
      messageParams: { since: DUE.toISOString() },
    })
    expect(byType(exceptions, 'low_stock')[0]).toMatchObject({
      messageKey: 'exceptions.msg.lowStock',
      messageParams: { quantity: 3, unit: 'kg', reorderLevel: 10 },
    })
    expect(byType(exceptions, 'pending_approval')[0]).toMatchObject({
      messageKey: 'exceptions.msg.awaitingApproval',
      messageParams: { assignee: 'Bola' },
    })

    const [withNotes, withoutNotes] = byType(exceptions, 'mortality_today')
    expect(withNotes).toMatchObject({
      titleKey: 'exceptions.title.batchMortality',
      titleParams: { batch: 'Noilers 12' },
      messageKey: 'exceptions.msg.mortalityWithNotes',
      messageParams: { count: 4, notes: 'heat stress' },
    })
    expect(withoutNotes).toMatchObject({
      messageKey: 'exceptions.msg.mortality',
      messageParams: { count: 1 },
    })
    expect(withoutNotes.messageParams).not.toHaveProperty('notes')

    expect(byType(exceptions, 'order_pending')[0]).toMatchObject({
      titleKey: 'exceptions.title.order',
      titleParams: { customer: 'Mama Ngozi' },
      messageKey: 'exceptions.msg.orderPending',
      messageParams: { currency: 'NGN', amount: 45000 },
    })
    expect(byType(exceptions, 'rejected_task')[0]).toMatchObject({
      messageKey: 'exceptions.msg.rejectedResubmit',
      messageParams: { assignee: 'Chidi' },
    })
    expect(byType(exceptions, 'asset_log_missing')[0]).toMatchObject({
      title: 'Tractor',
      messageKey: 'exceptions.msg.noDailyLog',
    })
    expect(byType(exceptions, 'asset_log_missing')[0].messageParams).toBeUndefined()

    const [named, unnamed] = byType(exceptions, 'asset_verification_pending')
    expect(named).toMatchObject({
      title: 'Generator',
      messageKey: 'exceptions.msg.reportedNeedsVerification',
      messageParams: { reporter: 'Dami' },
    })
    expect(named.titleKey).toBeUndefined()
    expect(unnamed).toMatchObject({
      title: 'Equipment log',
      titleKey: 'exceptions.title.assetLog',
      messageParams: { reporter: 'exceptions.staff' },
    })

    expect(byType(exceptions, 'census_missing')[0]).toMatchObject({
      title: 'Block C',
      messageKey: 'exceptions.msg.noCensus',
    })

    const [rejectedWithReason, rejectedPlain] = byType(exceptions, 'census_rejected')
    expect(rejectedWithReason).toMatchObject({
      titleKey: 'exceptions.title.censusSurvey',
      titleParams: { plot: 'Block D', crop: 'maize' },
      messageKey: 'exceptions.msg.censusRejectedWithReason',
      messageParams: { reason: 'blurred photo' },
    })
    expect(rejectedPlain).toMatchObject({
      title: 'Block · cassava',
      titleParams: { plot: 'exceptions.block', crop: 'cassava' },
      messageKey: 'exceptions.msg.censusRejected',
    })

    expect(byType(exceptions, 'census_stale')[0]).toMatchObject({
      messageKey: 'exceptions.msg.censusStale',
      messageParams: { days: 30, lastVerified: VERIFIED.toISOString() },
    })
  })

  it('falls back to the unknown-due-date key and threads the staleness window', async () => {
    queue({
      overdue: [
        {
          id: 'task-9',
          title: 'No due date',
          status: 'pending',
          dueDate: null,
          plotName: null,
          assignedToName: null,
        },
      ],
      censusStale: [{ id: 'plot-2', name: 'Block E', lastVerifiedAt: VERIFIED }],
    })
    const { exceptions } = await gatherExceptions(owner)

    const overdue = byType(exceptions, 'overdue_task')[0]
    expect(overdue.messageKey).toBe('exceptions.msg.overdueSinceUnknown')
    expect(overdue.messageParams).toBeUndefined()
    expect(overdue.message).toBe('Still open, no due date recorded')

    // The `{days}` param must come from the same constant the query uses.
    expect(censusRows.staleDaysArg).toBe(30)
    expect(byType(exceptions, 'census_stale')[0].messageParams?.days).toBe(
      censusRows.staleDaysArg,
    )
  })

  it('carries the fallback key, not the English word, for an unassigned task', async () => {
    queue({
      pendingApproval: [
        {
          id: 'task-4',
          title: 'Unowned',
          updatedAt: new Date('2026-07-24T08:00:00.000Z'),
          assignedToName: null,
        },
      ],
      rejected: [
        {
          id: 'task-5',
          title: 'Unowned too',
          updatedAt: new Date('2026-07-24T09:00:00.000Z'),
          assignedToName: null,
        },
      ],
    })
    const { exceptions } = await gatherExceptions(owner)

    const approval = byType(exceptions, 'pending_approval')[0]
    expect(approval.messageParams).toEqual({ assignee: 'exceptions.unassigned' })
    expect(approval.message).toBe('Awaiting approval for over 12h (unassigned)')

    const rejected = byType(exceptions, 'rejected_task')[0]
    expect(rejected.messageParams).toEqual({ assignee: 'exceptions.unassigned' })
    expect(rejected.message).toBe('Rejected - needs resubmission (unassigned)')
  })
})

describe('English copy is pinned exactly', () => {
  it('renders the reviewed English strings verbatim', async () => {
    queue(allRows())
    const { exceptions } = await gatherExceptions(owner)

    const messages = exceptions.map((e) => `${e.type}|${e.title}|${e.message}`)
    expect(messages).toEqual([
      // Re-baselined after the translation review reworded the source English:
      // deaths are named plainly, the reorder level carries its unit, the
      // missing-due-date branch no longer contradicts itself, and asset logs
      // are "equipment" everywhere, matching nav.assets in the UI catalogs.
      'overdue_task|Spray block A|Overdue since 21 Jul 2026',
      'low_stock|Urea|3 kg remaining (reorder at 10 kg)',
      'pending_approval|Weed block B|Awaiting approval for over 12h (Bola)',
      'mortality_today|Noilers 12 mortality|4 died: heat stress',
      'mortality_today|Layers 3 mortality|1 died',
      'order_pending|Order: Mama Ngozi|Pending over 48h - NGN 45000',
      'rejected_task|Fix fence|Rejected - needs resubmission (Chidi)',
      'asset_log_missing|Tractor|No daily log recorded yet today',
      'asset_verification_pending|Generator|Reported by Dami - needs verification',
      'asset_verification_pending|Equipment log|Reported by staff - needs verification',
      'census_missing|Block C|No verified crop census for this block',
      'census_rejected|Block D · maize|Census rejected: blurred photo',
      'census_rejected|Block · cassava|Census rejected - needs resubmission',
      'census_stale|Block E|Verified census older than 30 days (last 2 May 2026)',
    ])
  })

  it('never leaks an ISO timestamp into user-facing copy', async () => {
    queue(allRows())
    const { exceptions, actionList } = await gatherExceptions(owner)

    const userFacing = [
      ...exceptions.flatMap((e) => [e.title, e.message]),
      ...actionList.map((a) => a.label),
    ]
    const isoTimestamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
    for (const text of userFacing) {
      expect(text).not.toMatch(isoTimestamp)
    }
    // Machine fields keep their ISO values for clients to re-format.
    expect(exceptions[0].timestamp).toBe(DUE.toISOString())
    expect(exceptions[0].messageParams?.since).toBe(DUE.toISOString())
  })
})

describe('buildActionList', () => {
  it('gives every action a label key, params and the source title key', async () => {
    queue(allRows())
    const { exceptions, actionList } = await gatherExceptions(owner)

    expect(actionList).toHaveLength(exceptions.length)
    for (const action of actionList) {
      expect(action.labelKey).toBeDefined()
      expect(action.labelParams).toHaveProperty('title')
    }

    expect(actionList.map((a) => a.priority)).toEqual(
      Array.from({ length: actionList.length }, (_, i) => i + 1),
    )
    expect(actionList.map((a) => `${a.action}|${a.labelKey}|${a.link}`)).toEqual([
      'review_task|exceptions.action.reviewOverdue|/tasks',
      'restock_item|exceptions.action.restock|/inventory',
      'approve_task|exceptions.action.approve|/tasks',
      'review_mortality|exceptions.action.reviewMortality|/livestock',
      'review_mortality|exceptions.action.reviewMortality|/livestock',
      'confirm_order|exceptions.action.confirmOrder|/sales',
      'resubmit_task|exceptions.action.resubmit|/tasks',
      'log_asset|exceptions.action.logEquipment|/assets',
      'verify_asset|exceptions.action.verifyAssetLog|/assets',
      'verify_asset|exceptions.action.verifyAssetLog|/assets',
      'record_census|exceptions.action.recordCensus|/zones',
      'resubmit_census|exceptions.action.resubmitCensus|/zones',
      'resubmit_census|exceptions.action.resubmitCensus|/zones',
      'refresh_census|exceptions.action.refreshStaleCensus|/zones',
    ])

    // The customer-name override REPLACES the exception's title key. Carrying
    // both would make a translating client resolve 'Order: {customer}' into
    // the label and render "Confirm order: Order: Mama Ngozi".
    const order = actionList.find((a) => a.action === 'confirm_order')!
    expect(order.labelParams).toEqual({ title: 'Mama Ngozi' })
    expect(order.label).toBe('Confirm order: Mama Ngozi')
    expect(order.titleKey).toBeUndefined()
    expect(order.titleParams).toBeUndefined()

    const restock = actionList.find((a) => a.action === 'restock_item')!
    expect(restock.label).toBe('Restock: Urea')
    expect(restock.titleKey).toBeUndefined()
  })

  it('leaves already-localized weather exceptions without keys', async () => {
    // Mirrors routes/today.ts, which appends weather items after gathering.
    queue({})
    const { exceptions, actionList } = await gatherExceptions(owner)
    expect(exceptions).toHaveLength(0)
    expect(actionList).toHaveLength(0)

    exceptions.push({
      type: 'weather_heat',
      severity: 'high',
      title: 'Chaleur extrême',
      message: 'Prévu 39°C',
      entityType: 'weather',
      entityId: 'farm-1:heat',
      timestamp: new Date().toISOString(),
      metadata: { weatherType: 'heat' },
    })
    expect(exceptions[0].messageKey).toBeUndefined()
    expect(exceptions[0].titleKey).toBeUndefined()
  })
})
