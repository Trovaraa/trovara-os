import type { TaskStatus, UserRole } from '../db/schema.js'

export type { TaskStatus } from '../db/schema.js'

export type OrderStatus = 'pending' | 'confirmed' | 'dispatched' | 'delivered' | 'cancelled'

export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['in_progress'],
  in_progress: ['awaiting_approval'],
  awaiting_approval: ['completed', 'rejected'],
  rejected: ['in_progress'],
  completed: [],
}

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['dispatched', 'cancelled'],
  dispatched: ['delivered'],
  delivered: [],
  cancelled: [],
}

export const CROP_STAGES = [
  'planted',
  'germination',
  'vegetative',
  'flowering',
  'fruiting',
  'harvest_ready',
  'harvested',
] as const

export type CropStage = (typeof CROP_STAGES)[number]

export type TaskTransitionContext = {
  isOwnTask: boolean
  performedWorkSelf?: boolean
}

export type CropStageContext = {
  ownerOverride?: boolean
}

export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (TASK_TRANSITIONS[from] ?? []).includes(to)
}

export function isValidOrderTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to)
}

export function isValidCropStageAdvance(from: CropStage, to: CropStage): boolean {
  const fromIdx = CROP_STAGES.indexOf(from)
  const toIdx = CROP_STAGES.indexOf(to)
  if (fromIdx === -1 || toIdx === -1) return false
  return toIdx === fromIdx + 1
}

export function canWorkerTransitionTask(
  from: TaskStatus,
  to: TaskStatus,
  role: UserRole,
  isOwnTask: boolean,
): boolean {
  if (role !== 'field_worker' || !isOwnTask) return false
  return (
    (from === 'pending' && to === 'in_progress') ||
    (from === 'in_progress' && to === 'awaiting_approval') ||
    (from === 'rejected' && to === 'in_progress')
  )
}

export function canTransitionTask(
  from: TaskStatus,
  to: TaskStatus,
  role: UserRole,
  ctx: TaskTransitionContext,
): boolean {
  if (from === to) return true

  if (role === 'field_worker') {
    return canWorkerTransitionTask(from, to, role, ctx.isOwnTask)
  }

  if (role !== 'owner' && role !== 'supervisor') return false

  if (to === 'completed') {
    if (from === 'awaiting_approval') return true
    if (ctx.performedWorkSelf && from === 'in_progress') return true
    return false
  }

  if (to === 'rejected') {
    return from === 'awaiting_approval'
  }

  return isValidTaskTransition(from, to)
}

export function canTransitionOrder(
  from: OrderStatus,
  to: OrderStatus,
  role: UserRole,
): boolean {
  if (role !== 'owner' && role !== 'supervisor') return false
  if (from === to) return true
  return isValidOrderTransition(from, to)
}

export function canAdvanceCropStage(
  from: CropStage,
  to: CropStage,
  role: UserRole,
  ctx: CropStageContext = {},
): boolean {
  if (role !== 'owner' && role !== 'supervisor') return false
  if (from === to) return true

  if (ctx.ownerOverride && role === 'owner') {
    const fromIdx = CROP_STAGES.indexOf(from)
    const toIdx = CROP_STAGES.indexOf(to)
    return fromIdx !== -1 && toIdx !== -1 && toIdx > fromIdx
  }

  return isValidCropStageAdvance(from, to)
}

/** @deprecated Use isValidTaskTransition - kept for tests */
export const canTransitionTaskBasic = isValidTaskTransition

/** @deprecated Use isValidOrderTransition - kept for tests */
export const canTransitionOrderBasic = isValidOrderTransition

/** @deprecated Use isValidCropStageAdvance - kept for tests */
export const canAdvanceCropStageOneStep = isValidCropStageAdvance

export function canSupervisorTransitionTask(from: TaskStatus, to: TaskStatus, role: UserRole): boolean {
  if (role !== 'owner' && role !== 'supervisor') return false
  if (to === 'completed' || to === 'rejected') {
    return from === 'awaiting_approval'
  }
  return isValidTaskTransition(from, to) || from === to
}
