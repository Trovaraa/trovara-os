import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserRole } from '../db/schema.js'
import type { SessionUser } from './session.js'

type Row = {
  id: string
  userId: string
  userName: string
  role: UserRole
  clockInAt: Date
  clockOutAt: Date | null
  plotName: string | null
  taskTitle: string | null
  notes: string | null
  workSummary: string | null
  rangeStart: Date
  rangeEnd: Date
}

let rows: Row[] = []
const whereConditions: SQL[] = []

vi.mock('../db/index.js', () => ({
  db: {
    select: () => {
      const query: Record<string, unknown> = {}
      const same = () => query
      Object.assign(query, {
        from: same,
        innerJoin: same,
        leftJoin: same,
        where: (condition: SQL) => {
          whereConditions.push(condition)
          return query
        },
        orderBy: same,
        then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      })
      return query
    },
  },
}))

vi.mock('./audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('./farm-notify.js', () => ({ notifyWorkerClockIn: vi.fn() }))

const { listHoursSummary } = await import('./attendance-service.js')
const dialect = new PgDialect()

function user(role: UserRole, id = `user-${role}`): SessionUser {
  return {
    id,
    farmId: 'farm-1',
    email: `${id}@example.com`,
    name: role,
    role,
    mustChangePassword: false,
  }
}

function session(overrides: Partial<Row> = {}): Row {
  return {
    id: 'session-1',
    userId: 'worker-1',
    userName: 'Ada',
    role: 'field_worker',
    clockInAt: new Date('2026-08-10T07:00:00.000Z'),
    clockOutAt: new Date('2026-08-10T15:00:00.000Z'),
    plotName: 'North field',
    taskTitle: 'Weeding',
    notes: null,
    workSummary: 'Completed rows 1–4',
    rangeStart: new Date('2026-08-04T00:00:00.000Z'),
    rangeEnd: new Date('2026-08-11T00:00:00.000Z'),
    ...overrides,
  }
}

function renderedWhere() {
  expect(whereConditions).toHaveLength(1)
  return dialect.sqlToQuery(whereConditions[0]!)
}

beforeEach(() => {
  rows = []
  whereConditions.length = 0
  vi.useRealTimers()
})

describe('hours summary role visibility', () => {
  it.each(['owner', 'supervisor'] as const)('%s can read the farm-wide summary', async (role) => {
    await listHoursSummary(user(role), 'week')

    const query = renderedWhere()
    expect(query.params).toContain('farm-1')
    expect(query.params).not.toContain(`user-${role}`)
  })

  it.each(['sales', 'field_worker'] as const)('%s is restricted to their own hours', async (role) => {
    const actor = user(role)
    await listHoursSummary(actor, 'week')

    expect(renderedWhere().params).toContain(actor.id)
  })

  it.each(['sales', 'field_worker'] as const)(
    '%s cannot request another staff member',
    async (role) => {
      await expect(
        listHoursSummary(user(role), 'week', '11111111-1111-4111-8111-111111111111'),
      ).rejects.toThrow('FORBIDDEN')
      expect(whereConditions).toHaveLength(0)
    },
  )

  it('lets managers filter the farm summary to one staff member', async () => {
    await listHoursSummary(
      user('supervisor'),
      'month',
      '11111111-1111-4111-8111-111111111111',
    )

    expect(renderedWhere().params).toContain('11111111-1111-4111-8111-111111111111')
  })

  it('restricts a supervisor without attendance.roster to their own hours', async () => {
    const actor = { ...user('supervisor'), permissions: [] }
    await listHoursSummary(actor, 'week')
    expect(renderedWhere().params).toContain(actor.id)
  })

  it('allows a custom role grant for attendance.roster', async () => {
    const actor = { ...user('field_worker'), permissions: ['attendance.roster' as const] }
    await listHoursSummary(actor, 'week')
    expect(renderedWhere().params).not.toContain(actor.id)
  })
})

describe('hours summary aggregation and ranges', () => {
  it('groups sessions by person, totals minutes, and sorts longest first', async () => {
    rows = [
      session({ id: 'ada-1' }),
      session({
        id: 'bola-1',
        userId: 'worker-2',
        userName: 'Bola',
        clockInAt: new Date('2026-08-10T07:00:00.000Z'),
        clockOutAt: new Date('2026-08-10T11:00:00.000Z'),
      }),
      session({
        id: 'ada-2',
        clockInAt: new Date('2026-08-09T08:00:00.000Z'),
        clockOutAt: new Date('2026-08-09T10:30:00.000Z'),
        workSummary: null,
      }),
    ]

    const result = await listHoursSummary(user('owner'), 'week')

    expect(result.range).toBe('week')
    expect(result.people.map((person) => person.userName)).toEqual(['Ada', 'Bola'])
    expect(result.people[0]).toMatchObject({
      totalMinutes: 630,
      sessionCount: 2,
    })
    expect(result.people[0]!.sessions.map((entry) => entry.payableMinutes)).toEqual([480, 150])
    expect(result.people[1]).toMatchObject({ totalMinutes: 240, sessionCount: 1 })
  })

  it.each([
    ['day', "date_trunc('day'", "interval '1 day'"],
    ['week', "date_trunc('week'", "interval '7 days'"],
    ['month', "date_trunc('month'", "interval '1 month'"],
    ['ytd', "date_trunc('year'", "interval '1 year'"],
  ] as const)('uses farm-local %s boundaries', async (range, startSql, endSql) => {
    await listHoursSummary(user('owner'), range)

    const query = renderedWhere()
    expect(query.sql).toContain(startSql)
    expect(query.sql).toContain(endSql)
    expect(query.sql).toContain('timezone')
  })

  it('counts an open session through the current time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T10:15:00.000Z'))
    rows = [session({ clockInAt: new Date('2026-08-10T07:00:00.000Z'), clockOutAt: null })]

    const result = await listHoursSummary(user('owner'), 'day')

    expect(result.people[0]).toMatchObject({ totalMinutes: 195, sessionCount: 1 })
    expect(result.people[0]!.sessions[0]!.payableMinutes).toBe(195)
  })

  it('counts only the overlap with the requested range', async () => {
    rows = [
      session({
        clockInAt: new Date('2026-08-03T22:00:00.000Z'),
        clockOutAt: new Date('2026-08-04T02:00:00.000Z'),
      }),
    ]

    const result = await listHoursSummary(user('owner'), 'week')
    expect(result.people[0]).toMatchObject({ totalMinutes: 120 })
  })
})
