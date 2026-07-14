import type { CropStage } from './state-machines.js'

export type LifecycleTaskSuggestion = {
  templateName: string
  description: string
  offsetDaysFromStageStart: number
  defaultDurationHours?: number
}

export type LifecycleStage = {
  stage: CropStage
  durationDays: number
  taskSuggestions: LifecycleTaskSuggestion[]
}

export type CropLifecycleTemplate = {
  cropType: string
  totalDays: number
  stages: LifecycleStage[]
}

export const PLANTAIN_LIFECYCLE: CropLifecycleTemplate = {
  cropType: 'plantain',
  totalDays: 365,
  stages: [
    {
      stage: 'planted',
      durationDays: 14,
      taskSuggestions: [
        {
          templateName: 'Plantain planting inspection',
          description: 'Check sucker placement and initial watering',
          offsetDaysFromStageStart: 1,
          defaultDurationHours: 2,
        },
      ],
    },
    {
      stage: 'germination',
      durationDays: 30,
      taskSuggestions: [
        {
          templateName: 'Plantain weeding',
          description: 'Clear weeds around young plantain suckers',
          offsetDaysFromStageStart: 7,
          defaultDurationHours: 4,
        },
      ],
    },
    {
      stage: 'vegetative',
      durationDays: 90,
      taskSuggestions: [
        {
          templateName: 'Plantain weeding',
          description: 'Inter-row weeding and mulching',
          offsetDaysFromStageStart: 14,
          defaultDurationHours: 4,
        },
        {
          templateName: 'Plantain fertilization',
          description: 'Apply organic fertilizer to plantain rows',
          offsetDaysFromStageStart: 45,
          defaultDurationHours: 3,
        },
      ],
    },
    {
      stage: 'flowering',
      durationDays: 45,
      taskSuggestions: [
        {
          templateName: 'Plantain pest inspection',
          description: 'Inspect for weevil and nematode damage',
          offsetDaysFromStageStart: 10,
          defaultDurationHours: 2,
        },
      ],
    },
    {
      stage: 'fruiting',
      durationDays: 60,
      taskSuggestions: [
        {
          templateName: 'Plantain bunch support',
          description: 'Prop fruiting bunches and remove dry leaves',
          offsetDaysFromStageStart: 14,
          defaultDurationHours: 3,
        },
      ],
    },
    {
      stage: 'harvest_ready',
      durationDays: 14,
      taskSuggestions: [
        {
          templateName: 'Plantain harvest prep',
          description: 'Mark mature bunches for harvest',
          offsetDaysFromStageStart: 7,
          defaultDurationHours: 2,
        },
      ],
    },
    {
      stage: 'harvested',
      durationDays: 0,
      taskSuggestions: [],
    },
  ],
}

export const COCONUT_LIFECYCLE: CropLifecycleTemplate = {
  cropType: 'coconut',
  totalDays: 730,
  stages: [
    {
      stage: 'planted',
      durationDays: 30,
      taskSuggestions: [
        {
          templateName: 'Coconut seedling watering',
          description: 'Daily irrigation for newly planted seedlings',
          offsetDaysFromStageStart: 1,
          defaultDurationHours: 2,
        },
      ],
    },
    {
      stage: 'germination',
      durationDays: 60,
      taskSuggestions: [
        {
          templateName: 'Coconut irrigation',
          description: 'Regular irrigation for establishing seedlings',
          offsetDaysFromStageStart: 3,
          defaultDurationHours: 2,
        },
      ],
    },
    {
      stage: 'vegetative',
      durationDays: 365,
      taskSuggestions: [
        {
          templateName: 'Coconut irrigation',
          description: 'Scheduled irrigation during dry season',
          offsetDaysFromStageStart: 30,
          defaultDurationHours: 3,
        },
        {
          templateName: 'Coconut fertilization',
          description: 'Apply NPK and organic matter around base',
          offsetDaysFromStageStart: 90,
          defaultDurationHours: 4,
        },
        {
          templateName: 'Coconut weeding',
          description: 'Clear weeds in coconut block',
          offsetDaysFromStageStart: 60,
          defaultDurationHours: 4,
        },
      ],
    },
    {
      stage: 'flowering',
      durationDays: 180,
      taskSuggestions: [
        {
          templateName: 'Coconut pest inspection',
          description: 'Check for rhinoceros beetle and red palm weevil',
          offsetDaysFromStageStart: 30,
          defaultDurationHours: 2,
        },
      ],
    },
    {
      stage: 'fruiting',
      durationDays: 90,
      taskSuggestions: [
        {
          templateName: 'Coconut harvest monitoring',
          description: 'Monitor nut maturity and pollination',
          offsetDaysFromStageStart: 45,
          defaultDurationHours: 2,
        },
      ],
    },
    {
      stage: 'harvest_ready',
      durationDays: 30,
      taskSuggestions: [
        {
          templateName: 'Coconut harvest',
          description: 'Harvest mature coconuts from block',
          offsetDaysFromStageStart: 14,
          defaultDurationHours: 6,
        },
      ],
    },
    {
      stage: 'harvested',
      durationDays: 0,
      taskSuggestions: [],
    },
  ],
}

export const CROP_LIFECYCLES: Record<string, CropLifecycleTemplate> = {
  plantain: PLANTAIN_LIFECYCLE,
  coconut: COCONUT_LIFECYCLE,
}

export function getLifecycleForCrop(cropType: string): CropLifecycleTemplate | undefined {
  return CROP_LIFECYCLES[cropType.toLowerCase()]
}
