import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/index.js'
import { tasks } from '../db/schema.js'
import type { TaskStatus, UserRole } from '../db/schema.js'
import { clockIn, clockOut } from './attendance-service.js'
import { logAudit } from './audit.js'
import { canApproveTasks } from './rbac.js'
import type { SessionUser } from './session.js'
import { canTransitionTask } from './state-machines.js'
import { processEvidenceValue } from './evidence-store.js'
import { notifyTaskRejected, notifyTaskSubmittedForApproval } from './farm-notify.js'
import { staffLocale, type StaffLocale } from './order-messages.js'
import { mergeContentLocale, type ContentLocaleMeta } from './task-drafts.js'
import { roleCommandHelp } from './role-menus.js'

export type StaffOpsActor = {
  id: string
  farmId: string
  role: UserRole
  name: string
  preferredLocale?: string | null
}

export type StaffOpsResult = {
  handled: boolean
  reply?: string
  replyMarkup?: Record<string, unknown>
}

function toSession(actor: StaffOpsActor): SessionUser {
  return {
    id: actor.id,
    farmId: actor.farmId,
    email: '',
    name: actor.name,
    role: actor.role,
    mustChangePassword: false,
  }
}

export function taskReference(taskId: string): string {
  return `TSK-${taskId.replace(/-/g, '').slice(0, 6).toUpperCase()}`
}

export async function findTaskByReference(farmId: string, rawRef: string) {
  const ref = rawRef.trim().toUpperCase()
  const match = ref.match(/^(?:TSK-)?([A-F0-9]{6})$/i)
  if (!match) return null
  const prefix = match[1]!.toUpperCase()
  const rows = await db.select().from(tasks).where(eq(tasks.farmId, farmId))
  return rows.find((t) => taskReference(t.id) === `TSK-${prefix}`) ?? null
}

function taskPickerKeyboard(
  action: 'start' | 'done' | 'approve' | 'reject',
  rows: Array<{ id: string; label: string }>,
) {
  return {
    inline_keyboard: rows.slice(0, 8).map((row) => [
      { text: row.label.slice(0, 64), callback_data: `task:${action}:${row.id}` },
    ]),
  }
}

function msg(locale: StaffLocale, table: Record<StaffLocale, string>): string {
  return table[locale] ?? table.en
}

export function parseStaffOpsCommand(text: string): {
  action:
    | 'clock_in'
    | 'clock_out'
    | 'tasks'
    | 'start'
    | 'done'
    | 'approve'
    | 'reject'
    | 'help'
  ref?: string
  note?: string
} | null {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()

  if (
    /^(?:\/)?(?:clock[\s_-]?in|check[\s_-]?in|signin|sign[\s_-]?in)$/i.test(lower) ||
    lower === 'i am here' ||
    lower === "i'm here"
  ) {
    return { action: 'clock_in' }
  }
  if (
    /^(?:\/)?(?:clock[\s_-]?out|check[\s_-]?out|signout|sign[\s_-]?out)$/i.test(lower) ||
    lower === 'i am done for today' ||
    lower === "i'm done for today"
  ) {
    return { action: 'clock_out' }
  }
  if (/^(?:\/)?(?:tasks|mytasks|my\s+tasks)$/i.test(lower)) {
    return { action: 'tasks' }
  }
  if (/^(?:\/)?(?:ops|fieldhelp|field\s+help)$/i.test(lower) || lower === '/start') {
    return { action: 'help' }
  }

  const withRef = trimmed.match(
    /^\/?(start|begin|taskstart|done|complete|finish|approve|reject)\s+(\S+)(?:\s+(.+))?$/i,
  )
  if (withRef) {
    const raw = withRef[1]!.toLowerCase()
    const action =
      raw === 'start' || raw === 'begin' || raw === 'taskstart'
        ? 'start'
        : raw === 'approve'
          ? 'approve'
          : raw === 'reject'
            ? 'reject'
            : 'done'
    return { action, ref: withRef[2], note: withRef[3]?.trim() }
  }

  const bare = trimmed.match(/^\/?(start|begin|taskstart|done|complete|finish|approve|reject)$/i)
  if (bare) {
    const raw = bare[1]!.toLowerCase()
    const action =
      raw === 'start' || raw === 'begin' || raw === 'taskstart'
        ? 'start'
        : raw === 'approve'
          ? 'approve'
          : raw === 'reject'
            ? 'reject'
            : 'done'
    return { action }
  }

  return null
}

export function staffOpsHelp(locale: StaffLocale, role: UserRole): string {
  return roleCommandHelp(locale, role)
}

async function listMyOpenTasks(actor: StaffOpsActor) {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.farmId, actor.farmId),
        eq(tasks.assignedToId, actor.id),
        inArray(tasks.status, ['pending', 'in_progress', 'rejected']),
      ),
    )
    .orderBy(asc(tasks.dueDate), desc(tasks.updatedAt))
    .limit(12)
}

async function listAwaitingApproval(farmId: string) {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
    })
    .from(tasks)
    .where(and(eq(tasks.farmId, farmId), eq(tasks.status, 'awaiting_approval')))
    .orderBy(desc(tasks.updatedAt))
    .limit(12)
}

async function updateTaskStatus(params: {
  actor: StaffOpsActor
  taskId: string
  toStatus: TaskStatus
  note?: string | null
  photoUrl?: string | null
  /**
   * How `note` was normalized. The channel translates it before delegating here
   * and only the channel knows whether that succeeded; without it the note is
   * assumed to already be English, which is the behaviour callers had before.
   */
  noteLocale?: ContentLocaleMeta
}): Promise<{ ok: true; task: typeof tasks.$inferSelect } | { ok: false; error: string }> {
  const user = toSession(params.actor)
  const locale = staffLocale(params.actor.preferredLocale)
  const [existing] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, params.taskId), eq(tasks.farmId, params.actor.farmId)))
    .limit(1)
  if (!existing) return { ok: false, error: 'Task not found' }

  const isOwnTask = existing.assignedToId === params.actor.id
  const performedWorkSelf =
    isOwnTask && (params.actor.role === 'supervisor' || params.actor.role === 'owner')

  if (params.actor.role === 'field_worker' && !isOwnTask) {
    return {
      ok: false,
      error: msg(locale, {
        en: 'That task is not assigned to you',
        fr: 'Cette tâche ne vous est pas assignée.',
        yo: 'Iṣẹ́ yẹn kò jẹ́ tiẹ.',
        pcm: 'Dat task no dey assign to you.',
      }),
    }
  }

  if (
    !canTransitionTask(existing.status as TaskStatus, params.toStatus, params.actor.role, {
      isOwnTask,
      performedWorkSelf,
    })
  ) {
    return {
      ok: false,
      error: msg(locale, {
        en: `Can't change task from ${existing.status} to ${params.toStatus}`,
        fr: `Impossible de passer la tâche de ${existing.status} à ${params.toStatus}`,
        yo: `Kò ṣe é yí iṣẹ́ látí ${existing.status} sí ${params.toStatus}`,
        pcm: `You no fit change task from ${existing.status} to ${params.toStatus}`,
      }),
    }
  }

  if (
    (params.toStatus === 'completed' || params.toStatus === 'rejected') &&
    !canApproveTasks(user) &&
    !(params.toStatus === 'completed' && performedWorkSelf)
  ) {
    return {
      ok: false,
      error: msg(locale, {
        en: 'Only Admin or Supervisor can approve or reject',
        fr: 'Seul Admin ou Superviseur peut approuver ou rejeter.',
        yo: 'Admin tàbí Alábòójútó nìkan ló lè fọwọ́sí tàbí kọ̀.',
        pcm: 'Only Admin or Supervisor fit approve or reject.',
      }),
    }
  }

  const updates: Partial<typeof existing> = {
    status: params.toStatus,
    updatedAt: new Date(),
  }
  if (params.note) {
    updates.completionNote = params.note.slice(0, 2000)
    Object.assign(updates, mergeContentLocale(existing, params.noteLocale))
  }
  if (params.photoUrl) {
    try {
      updates.photoUrl = await processEvidenceValue(params.actor.farmId, params.photoUrl)
    } catch {
      return { ok: false, error: 'Could not save photo' }
    }
  }
  if (params.toStatus === 'completed' || params.toStatus === 'rejected') {
    updates.approvedById = params.actor.id
    if (params.toStatus === 'completed') {
      updates.completedAt = new Date()
      updates.rejectionReason = null
    }
    if (params.toStatus === 'rejected') {
      updates.rejectionReason = params.note?.slice(0, 500) || 'Rejected via butler'
    }
  }

  const [task] = await db.update(tasks).set(updates).where(eq(tasks.id, params.taskId)).returning()
  await logAudit({
    farmId: params.actor.farmId,
    userId: params.actor.id,
    action: 'update',
    entityType: 'task',
    entityId: params.taskId,
    metadata: { status: params.toStatus, source: 'butler' },
  })

  if (
    params.toStatus === 'awaiting_approval' &&
    existing.status !== 'awaiting_approval' &&
    task
  ) {
    void notifyTaskSubmittedForApproval({
      farmId: params.actor.farmId,
      taskId: task.id,
      taskTitle: task.title,
      workerName: params.actor.name,
      note: params.note,
      actorUserId: params.actor.id,
    }).catch(() => undefined)
  }

  if (params.toStatus === 'rejected' && existing.status !== 'rejected' && task) {
    void notifyTaskRejected({
      farmId: params.actor.farmId,
      assignedToId: task.assignedToId,
      taskId: task.id,
      taskTitle: task.title,
      reason: task.rejectionReason,
      actorUserId: params.actor.id,
    }).catch(() => undefined)
  }

  return { ok: true, task }
}

export async function tryHandleStaffOpsCommand(params: {
  actor: StaffOpsActor
  text: string
  photoUrl?: string | null
  /** How the note in `text` was normalized, when the caller translated it. */
  noteLocale?: ContentLocaleMeta
}): Promise<StaffOpsResult> {
  const locale = staffLocale(params.actor.preferredLocale)
  const parsed = parseStaffOpsCommand(params.text)
  if (!parsed) return { handled: false }

  if (parsed.action === 'help') {
    return { handled: true, reply: staffOpsHelp(locale, params.actor.role) }
  }

  if (parsed.action === 'clock_in') {
    try {
      const result = await clockIn(toSession(params.actor))
      return {
        handled: true,
        reply: result.idempotent
          ? msg(locale, {
              en: 'Already clocked in.',
              fr: 'Déjà pointé.',
              yo: 'O ti clock in tẹ́lẹ̀.',
              pcm: 'You don already clock in.',
            })
          : msg(locale, {
              en: '✅ Clocked in. Have a good day on the farm.',
              fr: '✅ Pointage entrée enregistré. Bonne journée.',
              yo: '✅ O ti clock in. Ọjọ́ a dára.',
              pcm: '✅ You don clock in. Make the day go well.',
            }),
      }
    } catch (err) {
      const code = err instanceof Error ? err.message : 'failed'
      return {
        handled: true,
        reply:
          code === 'WAGE_NOT_SET'
            ? msg(locale, {
                en: 'Ask Admin to set your monthly wage before clock-in.',
                fr: 'Demandez à l’Admin de fixer votre salaire mensuel.',
                yo: 'Sọ fún Admin kí ó ṣètò owó oṣù rẹ.',
                pcm: 'Tell Admin make e set your monthly wage first.',
              })
            : msg(locale, {
                en: `Could not clock in (${code}).`,
                fr: `Impossible de pointer (${code}).`,
                yo: `Kò lè clock in (${code}).`,
                pcm: `I no fit clock in (${code}).`,
              }),
      }
    }
  }

  if (parsed.action === 'clock_out') {
    try {
      const result = await clockOut(toSession(params.actor))
      return {
        handled: true,
        reply: result.idempotent
          ? msg(locale, {
              en: 'Already clocked out.',
              fr: 'Déjà pointé sortie.',
              yo: 'O ti clock out tẹ́lẹ̀.',
              pcm: 'You don already clock out.',
            })
          : msg(locale, {
              en: '✅ Clocked out. See you next shift.',
              fr: '✅ Pointage sortie enregistré.',
              yo: '✅ O ti clock out. A ó rí ọ lẹ́ẹ̀kan sí i.',
              pcm: '✅ You don clock out. See you next shift.',
            }),
      }
    } catch (err) {
      const code = err instanceof Error ? err.message : 'failed'
      return {
        handled: true,
        reply:
          code === 'NOT_CLOCKED_IN'
            ? msg(locale, {
                en: 'You are not clocked in.',
                fr: 'Vous n’êtes pas pointé.',
                yo: 'O kò tíì clock in.',
                pcm: 'You never clock in.',
              })
            : msg(locale, {
                en: `Could not clock out (${code}).`,
                fr: `Impossible de sortir (${code}).`,
                yo: `Kò lè clock out (${code}).`,
                pcm: `I no fit clock out (${code}).`,
              }),
      }
    }
  }

  if (parsed.action === 'tasks') {
    const rows = await listMyOpenTasks(params.actor)
    if (!rows.length) {
      return {
        handled: true,
        reply: msg(locale, {
          en: 'No open tasks assigned to you.',
          fr: 'Aucune tâche ouverte pour vous.',
          yo: 'Kò sí iṣẹ́ ṣíṣí fún ọ.',
          pcm: 'No open task for you.',
        }),
      }
    }
    const lines = rows.map(
      (t) => `• ${taskReference(t.id)} [${t.status}] ${t.title}`,
    )
    return {
      handled: true,
      reply: msg(locale, {
        en: `Your tasks:\n${lines.join('\n')}\n\n/start or /done to act.`,
        fr: `Vos tâches :\n${lines.join('\n')}\n\n/start ou /done.`,
        yo: `Iṣẹ́ rẹ:\n${lines.join('\n')}\n\n/start tàbí /done.`,
        pcm: `Your tasks:\n${lines.join('\n')}\n\n/start or /done.`,
      }),
    }
  }

  const pickerAction =
    parsed.action === 'start'
      ? 'start'
      : parsed.action === 'done'
        ? 'done'
        : parsed.action === 'approve'
          ? 'approve'
          : 'reject'

  if (
    (parsed.action === 'approve' || parsed.action === 'reject') &&
    !canApproveTasks(toSession(params.actor))
  ) {
    return {
      handled: true,
      reply: msg(locale, {
        en: 'Only Admin or Supervisor can approve/reject tasks.',
        fr: 'Seuls Admin/Superviseur peuvent approuver.',
        yo: 'Admin tàbí Alábojútó nìkan lè fọwọ́sí.',
        pcm: 'Only Admin or Supervisor fit approve/reject.',
      }),
    }
  }

  if (!parsed.ref) {
    const rows =
      pickerAction === 'approve' || pickerAction === 'reject'
        ? await listAwaitingApproval(params.actor.farmId)
        : (await listMyOpenTasks(params.actor)).filter((t) =>
            pickerAction === 'start'
              ? t.status === 'pending' || t.status === 'rejected'
              : t.status === 'in_progress',
          )
    if (!rows.length) {
      return {
        handled: true,
        reply: msg(locale, {
          en: `No tasks available to ${pickerAction}.`,
          fr: `Aucune tâche pour ${pickerAction}.`,
          yo: `Kò sí iṣẹ́ fún ${pickerAction}.`,
          pcm: `No task available to ${pickerAction}.`,
        }),
      }
    }
    return {
      handled: true,
      reply: msg(locale, {
        en: `Select a task to ${pickerAction}:`,
        fr: `Choisissez une tâche à ${pickerAction} :`,
        yo: `Yan iṣẹ́ fún ${pickerAction}:`,
        pcm: `Select task to ${pickerAction}:`,
      }),
      replyMarkup: taskPickerKeyboard(
        pickerAction,
        rows.map((t) => ({
          id: t.id,
          label: `${taskReference(t.id)} · ${t.title}`,
        })),
      ),
    }
  }

  const task = await findTaskByReference(params.actor.farmId, parsed.ref)
  if (!task) {
    return {
      handled: true,
      reply: msg(locale, {
        en: `Task not found: ${parsed.ref}`,
        fr: `Tâche introuvable : ${parsed.ref}`,
        yo: `A kò rí iṣẹ́: ${parsed.ref}`,
        pcm: `Task not found: ${parsed.ref}`,
      }),
    }
  }

  const toStatus: TaskStatus =
    parsed.action === 'start'
      ? 'in_progress'
      : parsed.action === 'done'
        ? 'awaiting_approval'
        : parsed.action === 'approve'
          ? 'completed'
          : 'rejected'

  const result = await updateTaskStatus({
    actor: params.actor,
    taskId: task.id,
    toStatus,
    note: parsed.note,
    photoUrl: params.photoUrl,
    noteLocale: params.noteLocale,
  })

  if (!result.ok) {
    return { handled: true, reply: result.error }
  }

  return {
    handled: true,
    reply: msg(locale, {
      en: `✅ ${taskReference(task.id)} → ${toStatus}${parsed.note ? `\nNote: ${parsed.note}` : ''}`,
      fr: `✅ ${taskReference(task.id)} → ${toStatus}${parsed.note ? `\nNote : ${parsed.note}` : ''}`,
      yo: `✅ ${taskReference(task.id)} → ${toStatus}${parsed.note ? `\nÀkọsílẹ̀: ${parsed.note}` : ''}`,
      pcm: `✅ ${taskReference(task.id)} → ${toStatus}${parsed.note ? `\nNote: ${parsed.note}` : ''}`,
    }),
  }
}

export async function transitionTaskFromCallback(params: {
  actor: StaffOpsActor
  taskId: string
  action: 'start' | 'done' | 'approve' | 'reject'
  note?: string
  /** How `note` was normalized, when the caller translated it. */
  noteLocale?: ContentLocaleMeta
}): Promise<StaffOpsResult> {
  const toStatus: TaskStatus =
    params.action === 'start'
      ? 'in_progress'
      : params.action === 'done'
        ? 'awaiting_approval'
        : params.action === 'approve'
          ? 'completed'
          : 'rejected'
  const result = await updateTaskStatus({
    actor: params.actor,
    taskId: params.taskId,
    toStatus,
    note: params.note,
    noteLocale: params.noteLocale,
  })
  if (!result.ok) return { handled: true, reply: result.error }
  return {
    handled: true,
    reply: `✅ ${taskReference(params.taskId)} → ${toStatus}`,
  }
}

/** Sales role ops help — orders already covered separately. */
export function salesOpsHelp(locale: StaffLocale): string {
  return roleCommandHelp(locale, 'sales')
}
