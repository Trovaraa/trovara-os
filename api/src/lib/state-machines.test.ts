import { describe, expect, it } from 'vitest'
import {
  CROP_STAGES,
  canAdvanceCropStage,
  canSupervisorTransitionTask,
  canTransitionOrder,
  canTransitionTask,
  canWorkerTransitionTask,
  isValidCropStageAdvance,
  isValidOrderTransition,
  isValidTaskTransition,
} from './state-machines.js'

describe('isValidTaskTransition', () => {
  it('allows valid task transitions', () => {
    expect(isValidTaskTransition('pending', 'in_progress')).toBe(true)
    expect(isValidTaskTransition('in_progress', 'awaiting_approval')).toBe(true)
    expect(isValidTaskTransition('awaiting_approval', 'completed')).toBe(true)
    expect(isValidTaskTransition('awaiting_approval', 'rejected')).toBe(true)
    expect(isValidTaskTransition('rejected', 'in_progress')).toBe(true)
  })

  it('blocks invalid task transitions', () => {
    expect(isValidTaskTransition('pending', 'completed')).toBe(false)
    expect(isValidTaskTransition('completed', 'pending')).toBe(false)
    expect(isValidTaskTransition('in_progress', 'completed')).toBe(false)
  })
})

describe('canTransitionTask (role-aware)', () => {
  it('allows worker to progress own tasks', () => {
    expect(
      canTransitionTask('pending', 'in_progress', 'field_worker', { isOwnTask: true }),
    ).toBe(true)
    expect(
      canTransitionTask('in_progress', 'awaiting_approval', 'field_worker', { isOwnTask: true }),
    ).toBe(true)
  })

  it('allows supervisor to approve awaiting tasks', () => {
    expect(
      canTransitionTask('awaiting_approval', 'completed', 'supervisor', { isOwnTask: false }),
    ).toBe(true)
  })

  it('allows supervisor to complete own in-progress work', () => {
    expect(
      canTransitionTask('in_progress', 'completed', 'supervisor', {
        isOwnTask: true,
        performedWorkSelf: true,
      }),
    ).toBe(true)
  })
})

describe('canWorkerTransitionTask', () => {
  it('denies worker on others tasks or invalid transitions', () => {
    expect(canWorkerTransitionTask('pending', 'in_progress', 'field_worker', false)).toBe(false)
    expect(canWorkerTransitionTask('awaiting_approval', 'completed', 'field_worker', true)).toBe(false)
  })
})

describe('canSupervisorTransitionTask', () => {
  it('allows supervisor to approve or reject awaiting tasks', () => {
    expect(canSupervisorTransitionTask('awaiting_approval', 'completed', 'supervisor')).toBe(true)
    expect(canSupervisorTransitionTask('awaiting_approval', 'rejected', 'owner')).toBe(true)
  })

  it('blocks supervisor from skipping approval', () => {
    expect(canSupervisorTransitionTask('pending', 'completed', 'supervisor')).toBe(false)
  })
})

describe('isValidOrderTransition / canTransitionOrder', () => {
  it('allows valid order status transitions for supervisors', () => {
    expect(isValidOrderTransition('pending', 'confirmed')).toBe(true)
    expect(canTransitionOrder('pending', 'confirmed', 'supervisor')).toBe(true)
    expect(canTransitionOrder('dispatched', 'delivered', 'owner')).toBe(true)
  })

  it('allows sales role to transition orders', () => {
    expect(canTransitionOrder('pending', 'confirmed', 'sales')).toBe(true)
    expect(canTransitionOrder('confirmed', 'dispatched', 'sales')).toBe(true)
    expect(canTransitionOrder('dispatched', 'delivered', 'sales')).toBe(true)
  })

  it('blocks invalid order transitions', () => {
    expect(isValidOrderTransition('pending', 'delivered')).toBe(false)
    expect(canTransitionOrder('pending', 'delivered', 'field_worker')).toBe(false)
    expect(canTransitionOrder('cancelled', 'confirmed', 'owner')).toBe(false)
  })
})

describe('isValidCropStageAdvance / canAdvanceCropStage', () => {
  it('allows advancing one stage at a time', () => {
    expect(isValidCropStageAdvance('planted', 'germination')).toBe(true)
    expect(isValidCropStageAdvance('vegetative', 'flowering')).toBe(true)
    expect(canAdvanceCropStage('vegetative', 'flowering', 'supervisor')).toBe(true)
  })

  it('blocks skipping or reversing stages without override', () => {
    expect(isValidCropStageAdvance('planted', 'vegetative')).toBe(false)
    expect(canAdvanceCropStage('flowering', 'vegetative', 'owner')).toBe(false)
  })

  it('allows owner override to skip forward', () => {
    expect(
      canAdvanceCropStage('planted', 'vegetative', 'owner', { ownerOverride: true }),
    ).toBe(true)
  })

  it('covers full crop stage sequence', () => {
    for (let i = 0; i < CROP_STAGES.length - 1; i++) {
      expect(isValidCropStageAdvance(CROP_STAGES[i], CROP_STAGES[i + 1])).toBe(true)
    }
  })
})
