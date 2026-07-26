import { and, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  attendanceSessions,
  plots,
  tasks,
  users,
} from '../db/schema.js'
import { logAudit } from './audit.js'
import { payableMinutes } from './attendance-calculations.js'
import { authorLocaleHint, toCanonicalEnglish } from './content-locale.js'
import { notifyWorkerClockIn } from './farm-notify.js'
import { canApproveTasks } from './rbac.js'
import type { SessionUser } from './session.js'
import { contentLocaleValues, mergeContentLocale, type ContentLocaleMeta } from './task-drafts.js'

export type AttendanceAllocationInput = {
  plotId?: string | null
  taskId?: string | null
  notes?: string | null
}

export type AttendanceCorrectionInput = AttendanceAllocationInput & {
  clockInAt?: string
  clockOutAt?: string | null
  monthlyWageSnapshotNgn?: number
}

function cleanNotes(notes: string | null | undefined): string | null {
  return notes?.trim() || null
}

/**
 * `notes` is the only prose on an attendance row — what the worker typed on
 * their way into the field, or what the supervisor typed when correcting them.
 * Everything else is an id, a timestamp or the wage snapshot in naira.
 */
type CanonicalNotes = {
  text: string | null
  locale: ContentLocaleMeta
}

const NOTHING_TO_NORMALIZE: CanonicalNotes = {
  text: null,
  locale: { sourceLocale: null, translationStatus: 'done' },
}

/**
 * Normalize an attendance note to English for storage.
 *
 * A degraded translator yields the author's own words at status 'pending' so the
 * retry job repairs the row later: `attendance_sessions` sits at the 'done'
 * default, and a row that claims 'done' while holding Yoruba is never swept
 * again. The recorded locale is whatever the hint established and never 'en' —
 * `authorLocaleHint` has already dropped that — because a pending row claiming
 * English is one the retry job short-circuits straight back to 'done'.
 */
async function canonicalNotes(
  notes: string | null,
  farmId: string,
  hint: string | null,
): Promise<CanonicalNotes> {
  if (!notes) return NOTHING_TO_NORMALIZE
  try {
    const result = await toCanonicalEnglish({ text: notes, farmId, sourceLocale: hint })
    return {
      text: result.english,
      locale: { sourceLocale: result.sourceLocale, translationStatus: result.status },
    }
  } catch {
    // A translation failure must never fail a clock-in or a correction.
    return { text: notes, locale: { sourceLocale: hint, translationStatus: 'pending' } }
  }
}

/**
 * Locale hint for the author of a note. Everyone starts on the default 'en'
 * preference, so `authorLocaleHint` turns that into "detect it from the text".
 */
async function authorHint(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return authorLocaleHint(row?.preferredLocale)
}

async function validateAllocation(
  user: SessionUser,
  input: AttendanceAllocationInput,
): Promise<{ plotId: string | null; taskId: string | null }> {
  let plotId = input.plotId ?? null
  const taskId = input.taskId ?? null

  if (plotId) {
    const [plot] = await db
      .select({ id: plots.id })
      .from(plots)
      .where(and(eq(plots.id, plotId), eq(plots.farmId, user.farmId)))
      .limit(1)
    if (!plot) throw new Error('INVALID_PLOT')
  }

  if (taskId) {
    const [task] = await db
      .select({ id: tasks.id, plotId: tasks.plotId, assignedToId: tasks.assignedToId })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.farmId, user.farmId)))
      .limit(1)
    if (!task) throw new Error('INVALID_TASK')
    if (user.role === 'field_worker' && task.assignedToId !== user.id) {
      throw new Error('FORBIDDEN')
    }
    if (plotId && task.plotId && plotId !== task.plotId) throw new Error('ALLOCATION_MISMATCH')
    plotId ??= task.plotId
  }

  return { plotId, taskId }
}

export async function clockIn(user: SessionUser, input: AttendanceAllocationInput = {}) {
  if (user.role !== 'field_worker') throw new Error('FORBIDDEN')

  const [existing] = await db
    .select()
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.farmId, user.farmId),
        eq(attendanceSessions.userId, user.id),
        isNull(attendanceSessions.clockOutAt),
      ),
    )
    .limit(1)
  if (existing) return { session: existing, idempotent: true }

  // The worker's language preference rides along with the wage read, so a
  // clock-in still costs one profile query.
  const [{ monthlyWageNgn, preferredLocale }] = await db
    .select({ monthlyWageNgn: users.monthlyWageNgn, preferredLocale: users.preferredLocale })
    .from(users)
    .where(and(eq(users.id, user.id), eq(users.farmId, user.farmId)))
    .limit(1)
  if (monthlyWageNgn == null) throw new Error('WAGE_NOT_SET')

  const allocation = await validateAllocation(user, input)
  const typedNotes = cleanNotes(input.notes)
  const canonical = await canonicalNotes(
    typedNotes,
    user.farmId,
    authorLocaleHint(preferredLocale),
  )
  let session
  try {
    ;[session] = await db
      .insert(attendanceSessions)
      .values({
        farmId: user.farmId,
        userId: user.id,
        monthlyWageSnapshotNgn: monthlyWageNgn,
        ...allocation,
        notes: canonical.text,
        ...contentLocaleValues(canonical.locale),
      })
      .returning()
  } catch (error) {
    const [concurrent] = await db
      .select()
      .from(attendanceSessions)
      .where(
        and(
          eq(attendanceSessions.farmId, user.farmId),
          eq(attendanceSessions.userId, user.id),
          isNull(attendanceSessions.clockOutAt),
        ),
      )
      .limit(1)
    if (concurrent) return { session: concurrent, idempotent: true }
    throw error
  }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'attendance_clock_in',
    entityType: 'attendance_session',
    entityId: session.id,
    metadata: allocation,
  })

  void notifyWorkerClockIn({
    farmId: user.farmId,
    workerName: user.name,
    clockInAt: session.clockInAt,
    actorUserId: user.id,
    notes: session.notes,
  }).catch(() => undefined)

  // The worker reads their own note back in their own words; the row holds the
  // English.
  return { session: { ...session, notes: typedNotes ?? session.notes }, idempotent: false }
}

export async function clockOut(user: SessionUser) {
  if (user.role !== 'field_worker') throw new Error('FORBIDDEN')

  const now = new Date()
  const [session] = await db
    .update(attendanceSessions)
    .set({ clockOutAt: now })
    .where(
      and(
        eq(attendanceSessions.farmId, user.farmId),
        eq(attendanceSessions.userId, user.id),
        isNull(attendanceSessions.clockOutAt),
      ),
    )
    .returning()

  if (!session) {
    const [latest] = await db
      .select()
      .from(attendanceSessions)
      .where(
        and(
          eq(attendanceSessions.farmId, user.farmId),
          eq(attendanceSessions.userId, user.id),
        ),
      )
      .orderBy(desc(attendanceSessions.clockOutAt))
      .limit(1)
    if (!latest?.clockOutAt) throw new Error('NOT_CLOCKED_IN')
    return { session: latest, idempotent: true }
  }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'attendance_clock_out',
    entityType: 'attendance_session',
    entityId: session.id,
    metadata: { payableMinutes: payableMinutes(session.clockInAt, session.clockOutAt!) },
  })
  return { session, idempotent: false }
}

export async function listToday(user: SessionUser) {
  if (user.role === 'sales') return []

  const farmTimezone = sql<string>`COALESCE(
    (SELECT "timezone" FROM "farms" WHERE "id" = ${user.farmId}),
    'Africa/Lagos'
  )`
  const start = sql<Date>`(
    date_trunc('day', now() AT TIME ZONE ${farmTimezone}) AT TIME ZONE ${farmTimezone}
  )`
  const end = sql<Date>`(
    (date_trunc('day', now() AT TIME ZONE ${farmTimezone}) + interval '1 day')
    AT TIME ZONE ${farmTimezone}
  )`
  const visibility =
    user.role === 'field_worker'
      ? and(eq(attendanceSessions.farmId, user.farmId), eq(attendanceSessions.userId, user.id))
      : eq(attendanceSessions.farmId, user.farmId)

  const rows = await db
    .select({
      id: attendanceSessions.id,
      userId: attendanceSessions.userId,
      userName: users.name,
      clockInAt: attendanceSessions.clockInAt,
      clockOutAt: attendanceSessions.clockOutAt,
      monthlyWageSnapshotNgn: attendanceSessions.monthlyWageSnapshotNgn,
      plotId: attendanceSessions.plotId,
      plotName: plots.name,
      taskId: attendanceSessions.taskId,
      taskTitle: tasks.title,
      notes: attendanceSessions.notes,
      correctedById: attendanceSessions.correctedById,
      correctedAt: attendanceSessions.correctedAt,
      createdAt: attendanceSessions.createdAt,
    })
    .from(attendanceSessions)
    .innerJoin(users, eq(attendanceSessions.userId, users.id))
    .leftJoin(plots, eq(attendanceSessions.plotId, plots.id))
    .leftJoin(tasks, eq(attendanceSessions.taskId, tasks.id))
    .where(
      and(
        visibility,
        lt(attendanceSessions.clockInAt, end),
        or(isNull(attendanceSessions.clockOutAt), gte(attendanceSessions.clockOutAt, start)),
      ),
    )
    .orderBy(desc(attendanceSessions.clockInAt))

  const now = new Date()
  return rows.map((row) => ({
    ...row,
    payableMinutes: payableMinutes(row.clockInAt, row.clockOutAt ?? now),
  }))
}

export async function supervisorCorrect(
  user: SessionUser,
  sessionId: string,
  input: AttendanceCorrectionInput,
) {
  if (!canApproveTasks(user)) throw new Error('FORBIDDEN')

  const [existing] = await db
    .select()
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.id, sessionId),
        eq(attendanceSessions.farmId, user.farmId),
      ),
    )
    .limit(1)
  if (!existing) throw new Error('NOT_FOUND')

  const allocation = await validateAllocation(user, {
    plotId: input.plotId === undefined ? existing.plotId : input.plotId,
    taskId: input.taskId === undefined ? existing.taskId : input.taskId,
  })
  const clockInAt = input.clockInAt ? new Date(input.clockInAt) : existing.clockInAt
  const clockOutAt =
    input.clockOutAt === undefined
      ? existing.clockOutAt
      : input.clockOutAt === null
        ? null
        : new Date(input.clockOutAt)
  if (clockOutAt && clockOutAt < clockInAt) throw new Error('INVALID_TIME_RANGE')

  const typedNotes = input.notes === undefined ? undefined : cleanNotes(input.notes)
  // Only a correction that actually carries text needs a locale lookup or a
  // translator: fixing the times, or clearing the note, needs neither.
  const canonical = typedNotes
    ? await canonicalNotes(typedNotes, user.farmId, await authorHint(user.id))
    : null

  const [session] = await db
    .update(attendanceSessions)
    .set({
      clockInAt,
      clockOutAt,
      monthlyWageSnapshotNgn:
        input.monthlyWageSnapshotNgn ?? existing.monthlyWageSnapshotNgn,
      ...allocation,
      notes: typedNotes === undefined ? existing.notes : (canonical?.text ?? null),
      // The supervisor's note replaces the worker's, so a note that is not
      // English yet escalates the row to 'pending'; a row the retry job still
      // owes work on is left exactly as it is.
      ...(canonical ? mergeContentLocale(existing, canonical.locale) : {}),
      correctedById: user.id,
      correctedAt: new Date(),
    })
    .where(eq(attendanceSessions.id, sessionId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'attendance_correct',
    entityType: 'attendance_session',
    entityId: session.id,
    metadata: {
      before: {
        clockInAt: existing.clockInAt,
        clockOutAt: existing.clockOutAt,
        monthlyWageSnapshotNgn: existing.monthlyWageSnapshotNgn,
        plotId: existing.plotId,
        taskId: existing.taskId,
        notes: existing.notes,
      },
      after: {
        clockInAt: session.clockInAt,
        clockOutAt: session.clockOutAt,
        monthlyWageSnapshotNgn: session.monthlyWageSnapshotNgn,
        plotId: session.plotId,
        taskId: session.taskId,
        notes: session.notes,
      },
    },
  })

  // The supervisor reads their own note back in their own words; the row and the
  // audit trail hold the English.
  return typedNotes === undefined ? session : { ...session, notes: typedNotes }
}
