import type { UserRole } from '../db/schema.js'
import type { CropStage } from './state-machines.js'

export type AdvisoryNotifyRole = Extract<UserRole, 'owner' | 'supervisor' | 'field_worker'>

export type AdvisoryRuleDef = {
  ruleKey: string
  /** Days from stage start (crops) or acquiredAt (poultry). */
  offsetDays: number
  /** Match window ± days around offset. */
  windowDays?: number
  happeningNow: string
  whatNext: string
  needQuery: string
  notifyRoles: AdvisoryNotifyRole[]
  reasonCode: string
}

export type CropStagePlaybook = {
  cropType: string
  stage: CropStage
  rules: AdvisoryRuleDef[]
}

export type PoultryPlaybook = {
  batchType: 'broiler'
  rules: AdvisoryRuleDef[]
}

export const CROP_ADVISORY_PLAYBOOKS: CropStagePlaybook[] = [
  {
    cropType: 'plantain',
    stage: 'planted',
    rules: [
      {
        ruleKey: 'plantain.planted.inspect',
        offsetDays: 1,
        happeningNow: 'New plantain suckers are settling in.',
        whatNext: 'Check placement and water lightly today.',
        needQuery: 'organic compost seedling plantain',
        notifyRoles: ['field_worker', 'supervisor'],
        reasonCode: 'crop_stage_planted',
      },
    ],
  },
  {
    cropType: 'plantain',
    stage: 'vegetative',
    rules: [
      {
        ruleKey: 'plantain.vegetative.mulch',
        offsetDays: 14,
        happeningNow: 'Plantain is in vegetative growth.',
        whatNext: 'Weed between rows and refresh mulch.',
        needQuery: 'mulch organic plantain farm',
        notifyRoles: ['field_worker'],
        reasonCode: 'crop_stage_mulch',
      },
      {
        ruleKey: 'plantain.vegetative.fertilize',
        offsetDays: 45,
        happeningNow: 'Plantain vegetative stage mid-point.',
        whatNext: 'Apply organic fertilizer or compost around the base.',
        needQuery: 'organic fertilizer compost plantain',
        notifyRoles: ['field_worker', 'supervisor'],
        reasonCode: 'crop_stage_fertilize',
      },
    ],
  },
  {
    cropType: 'plantain',
    stage: 'flowering',
    rules: [
      {
        ruleKey: 'plantain.flowering.inspect',
        offsetDays: 10,
        happeningNow: 'Plantain is flowering.',
        whatNext: 'Inspect for weevil damage and keep the base mulched.',
        needQuery: 'organic mulch plantain farm',
        notifyRoles: ['field_worker', 'supervisor'],
        reasonCode: 'crop_stage_flowering',
      },
    ],
  },
  {
    cropType: 'plantain',
    stage: 'fruiting',
    rules: [
      {
        ruleKey: 'plantain.fruiting.support',
        offsetDays: 14,
        happeningNow: 'Plantain bunches are filling out.',
        whatNext: 'Prop heavy bunches and remove dry leaves.',
        needQuery: 'plantain props stakes farm tools',
        notifyRoles: ['field_worker', 'supervisor'],
        reasonCode: 'crop_stage_fruiting',
      },
    ],
  },
  {
    cropType: 'plantain',
    stage: 'harvest_ready',
    rules: [
      {
        ruleKey: 'plantain.harvest_ready.prep',
        offsetDays: 7,
        happeningNow: 'Plantain bunches are nearing harvest.',
        whatNext: 'Mark mature bunches and prepare crates for harvest.',
        needQuery: 'harvest crates packaging plantain',
        notifyRoles: ['supervisor', 'owner'],
        reasonCode: 'crop_stage_harvest_prep',
      },
    ],
  },
  {
    cropType: 'coconut',
    stage: 'planted',
    rules: [
      {
        ruleKey: 'coconut.planted.water',
        offsetDays: 1,
        happeningNow: 'Coconut seedlings need steady moisture.',
        whatNext: 'Irrigate newly planted seedlings today.',
        needQuery: 'irrigation watering can seedling coconut',
        notifyRoles: ['field_worker'],
        reasonCode: 'crop_stage_irrigation',
      },
    ],
  },
  {
    cropType: 'coconut',
    stage: 'vegetative',
    rules: [
      {
        ruleKey: 'coconut.vegetative.fertilize',
        offsetDays: 90,
        happeningNow: 'Coconut vegetative establishment continues.',
        whatNext: 'Apply organic matter / compost around the base.',
        needQuery: 'organic fertilizer compost coconut',
        notifyRoles: ['field_worker', 'supervisor'],
        reasonCode: 'crop_stage_fertilize',
      },
      {
        ruleKey: 'coconut.vegetative.weed',
        offsetDays: 60,
        happeningNow: 'Weeds compete with young coconuts.',
        whatNext: 'Clear weeds in the coconut block.',
        needQuery: 'mulch weeding tools farm',
        notifyRoles: ['field_worker'],
        reasonCode: 'crop_stage_weeding',
      },
    ],
  },
  {
    cropType: 'coconut',
    stage: 'flowering',
    rules: [
      {
        ruleKey: 'coconut.flowering.inspect',
        offsetDays: 30,
        happeningNow: 'Coconut flowering / early nut set.',
        whatNext: 'Check for beetle damage and keep the basin clear.',
        needQuery: 'organic fertilizer coconut basin',
        notifyRoles: ['field_worker', 'supervisor'],
        reasonCode: 'crop_stage_flowering',
      },
    ],
  },
  {
    cropType: 'coconut',
    stage: 'fruiting',
    rules: [
      {
        ruleKey: 'coconut.fruiting.monitor',
        offsetDays: 45,
        happeningNow: 'Coconuts are developing.',
        whatNext: 'Monitor nut maturity and plan harvest labour.',
        needQuery: 'coconut harvest bags packaging',
        notifyRoles: ['supervisor', 'owner'],
        reasonCode: 'crop_stage_fruiting',
      },
    ],
  },
  {
    cropType: 'coconut',
    stage: 'harvest_ready',
    rules: [
      {
        ruleKey: 'coconut.harvest_ready.harvest',
        offsetDays: 14,
        happeningNow: 'Coconuts are in a harvest window.',
        whatNext: 'Plan harvest labour and packaging for mature nuts.',
        needQuery: 'coconut harvest bags packaging',
        notifyRoles: ['supervisor', 'owner'],
        reasonCode: 'crop_stage_harvest_prep',
      },
    ],
  },
]

export const BROILER_ADVISORY_PLAYBOOK: PoultryPlaybook = {
  batchType: 'broiler',
  rules: [
    {
      ruleKey: 'broiler.day1.brooding',
      offsetDays: 1,
      happeningNow: 'Broiler brooding week has started.',
      whatNext: 'Check heat, litter dryness, and starter feed access.',
      needQuery: 'broiler starter feed electrolytes chicks',
      notifyRoles: ['field_worker', 'supervisor'],
      reasonCode: 'poultry_brooding',
    },
    {
      ruleKey: 'broiler.day7.gumboro',
      offsetDays: 7,
      happeningNow: 'Gumboro vaccination window is due.',
      whatNext: 'Confirm Gumboro vaccine with your vet/agrovet and schedule the dose.',
      needQuery: 'Gumboro vaccine poultry broiler',
      notifyRoles: ['supervisor', 'owner'],
      reasonCode: 'poultry_vaccination',
    },
    {
      ruleKey: 'broiler.day14.newcastle',
      offsetDays: 14,
      happeningNow: 'Newcastle booster window is approaching.',
      whatNext: 'Plan Lasota booster and review mortality logs.',
      needQuery: 'Newcastle Lasota vaccine broiler',
      notifyRoles: ['supervisor', 'owner'],
      reasonCode: 'poultry_vaccination',
    },
    {
      ruleKey: 'broiler.day21.litter',
      offsetDays: 21,
      happeningNow: 'Mid-cycle litter and feed check.',
      whatNext: 'Refresh wet litter and switch toward grower feed if advised.',
      needQuery: 'broiler grower feed litter poultry',
      notifyRoles: ['field_worker', 'supervisor'],
      reasonCode: 'poultry_litter_feed',
    },
    {
      ruleKey: 'broiler.day28.closeout',
      offsetDays: 28,
      happeningNow: 'Pre-closeout health window.',
      whatNext: 'Review flock health and prepare for closeout logistics.',
      needQuery: 'poultry disinfectant farm biosecurity',
      notifyRoles: ['supervisor', 'owner'],
      reasonCode: 'poultry_closeout',
    },
  ],
}

export const WEATHER_ADVISORY_RULES: Array<{
  alertType: 'rain' | 'heat' | 'wind' | 'cold'
  ruleKey: string
  happeningNow: string
  whatNext: string
  needQuery: string
  notifyRoles: AdvisoryNotifyRole[]
  reasonCode: string
}> = [
  {
    alertType: 'rain',
    ruleKey: 'weather.rain.field_delay',
    happeningNow: 'Heavy rain risk is in the forecast.',
    whatNext: 'Delay open-field spraying/fertiliser work; protect feed and litter.',
    needQuery: 'tarpaulin feed cover farm rain',
    notifyRoles: ['field_worker', 'supervisor'],
    reasonCode: 'weather_rain',
  },
  {
    alertType: 'heat',
    ruleKey: 'weather.heat.stress',
    happeningNow: 'Heat stress risk is elevated.',
    whatNext: 'Ensure shade, cool water, and electrolytes for poultry; avoid midday field work.',
    needQuery: 'poultry electrolytes heat stress',
    notifyRoles: ['field_worker', 'supervisor', 'owner'],
    reasonCode: 'weather_heat',
  },
  {
    alertType: 'wind',
    ruleKey: 'weather.wind.secure',
    happeningNow: 'Strong wind is forecast.',
    whatNext: 'Secure lightweight covers, nursery shades, and empty crates.',
    needQuery: 'shade net farm cover',
    notifyRoles: ['field_worker', 'supervisor'],
    reasonCode: 'weather_wind',
  },
]

/** Observation tiles for the Clue-style Track grid. */
export const CROP_OBSERVATION_TILES = [
  { key: 'yellowing', label: 'Yellowing leaves' },
  { key: 'wilting', label: 'Wilting' },
  { key: 'dry_soil', label: 'Dry soil' },
  { key: 'waterlogged', label: 'Waterlogged' },
  { key: 'pests_spotted', label: 'Pests spotted' },
  { key: 'weeds_high', label: 'Weeds high' },
  { key: 'growth_good', label: 'Growth looks good' },
  { key: 'ready_harvest', label: 'Ready to harvest' },
] as const

export const POULTRY_OBSERVATION_TILES = [
  { key: 'lethargy', label: 'Lethargy' },
  { key: 'low_feed', label: 'Low feed intake' },
  { key: 'high_mortality', label: 'High mortality' },
  { key: 'heat_stress', label: 'Heat stress' },
  { key: 'wet_litter', label: 'Wet litter' },
  { key: 'respiratory', label: 'Respiratory signs' },
  { key: 'birds_active', label: 'Birds active' },
  { key: 'feed_ok', label: 'Feed looking OK' },
] as const

export function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime()
  return Math.floor(ms / (24 * 60 * 60 * 1000))
}

export function isWithinOffsetWindow(
  daysSinceStart: number,
  offsetDays: number,
  windowDays = 1,
): boolean {
  return Math.abs(daysSinceStart - offsetDays) <= windowDays
}

/**
 * A tip is due from a few days early through a catch-up overdue window
 * (so mid-cycle seed data still surfaces recommendations).
 */
export function isRuleDue(
  daysSinceStart: number,
  offsetDays: number,
  opts?: { earlyDays?: number; overdueDays?: number },
): boolean {
  const early = opts?.earlyDays ?? 3
  const overdue = opts?.overdueDays ?? 21
  return daysSinceStart >= offsetDays - early && daysSinceStart <= offsetDays + overdue
}

/** Rules that should fire today for this day-in-cycle/stage. */
export function dueRulesForDay(
  daysSinceStart: number,
  rules: AdvisoryRuleDef[],
): AdvisoryRuleDef[] {
  const matched = rules.filter((rule) =>
    isRuleDue(daysSinceStart, rule.offsetDays, {
      earlyDays: rule.windowDays ?? 3,
      overdueDays: 21,
    }),
  )
  if (matched.length > 0) return matched

  // Deep into a stage with no rule in the ± window: surface the latest past tip once.
  const past = [...rules]
    .filter((r) => daysSinceStart >= r.offsetDays)
    .sort((a, b) => b.offsetDays - a.offsetDays)
  return past[0] ? [past[0]] : []
}
