import { poultryBatchTypeEnum, type UserRole } from '../db/schema.js'
import { renderAdvisoryFallback } from './advisory-fallback-messages.js'
import type { CropStage } from './state-machines.js'

export type AdvisoryNotifyRole = Extract<UserRole, 'owner' | 'supervisor' | 'field_worker'>

/**
 * SEED text, not farmer-facing output.
 *
 * These two strings describe the *topic* of a rule. `advisory-generate.ts` hands
 * them to the model together with live farm state (crop, stage, day-in-stage,
 * plot, weather, head count) and the model writes the sentences the farmer reads.
 * They are also the deterministic fallback whenever the LLM is off, over budget,
 * or returns something that fails validation.
 *
 * The fields keep the names `happeningNow` / `whatNext` deliberately:
 * `advisory-engine.ts` (the notification pipeline) reads them directly and is
 * owned elsewhere, so a rename would break it. The seed semantics live in this
 * type and in `ruleSeed()` instead.
 */
export type AdvisoryRuleSeed = {
  /** SEED — one line on what is happening at this point in the cycle. */
  happeningNow: string
  /** SEED — one line on the deterministic action this rule schedules. */
  whatNext: string
}

/**
 * Deterministic agronomy. `offsetDays`, `windowDays`, `notifyRoles`, `reasonCode`
 * and `needQuery` are never decided by a model — only the seed prose is rewritten.
 */
export type AdvisoryRuleDef = AdvisoryRuleSeed & {
  ruleKey: string
  /** Days from stage start (crops) or acquiredAt (poultry). */
  offsetDays: number
  /** Match window ± days around offset. */
  windowDays?: number
  needQuery: string
  notifyRoles: AdvisoryNotifyRole[]
  reasonCode: string
}

export type WeatherAdvisoryRuleDef = AdvisoryRuleSeed & {
  alertType: 'rain' | 'heat' | 'wind' | 'cold'
  ruleKey: string
  needQuery: string
  notifyRoles: AdvisoryNotifyRole[]
  reasonCode: string
}

/** Read a rule's seed prose explicitly, so call sites show it is prompt input, not output. */
export function ruleSeed(rule: AdvisoryRuleSeed): AdvisoryRuleSeed {
  return { happeningNow: rule.happeningNow, whatNext: rule.whatNext }
}

export type CropStagePlaybook = {
  cropType: string
  stage: CropStage
  rules: AdvisoryRuleDef[]
}

export type PoultryPlaybook = {
  /**
   * Read off the enum rather than written as a literal. The literal that used to
   * be here said 'broiler', and renaming the enum member did not rename it, so
   * the playbook silently claimed a batch type the column could no longer store.
   */
  batchType: (typeof poultryBatchTypeEnum.enumValues)[number]
  rules: AdvisoryRuleDef[]
}

/**
 * The generic crop calendar, used only for a cycle that has no plan of its own.
 *
 * These offsets are not this farm's agronomy. They are a coarse sketch of two
 * crops, kept so a cycle still gets prompted when plan generation is switched
 * off, failed, or has never run for it. The authoritative dates live per cycle
 * in `crop_cycle_tasks`, written against the crop the farmer entered and counted
 * from the day each stage was actually reached, and correctable by the person
 * growing it; `cropRulesForCycle` prefers those rows whenever a cycle has any.
 *
 * The two crops below are the two this table happens to cover, not the two a
 * farm may grow. A cassava or tomato cycle with no plan gets nothing here, which
 * is the honest answer: a fallback should not assert timings it cannot know are
 * right for what is in the ground.
 */
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

/**
 * The generic poultry calendar, used only for a batch that has none of its own.
 *
 * These offsets are not this farm's agronomy and are nobody's veterinary
 * advice. They are a coarse early-cycle husbandry sketch, kept so a flock still
 * gets prompted when schedule generation is switched off, failed, or has never
 * run for that batch. The authoritative dates live per batch in
 * `livestock_schedule_entries`, written against the batch's own breed and start
 * date and correctable by the person who keeps the birds;
 * `poultryRulesForBatch` prefers those rows whenever a batch has any.
 *
 * Nothing here names a breed, in the prose or in the `needQuery` strings, for
 * the same reason: a fallback should not assert timings it cannot know are
 * right for the birds in the pen.
 */
export const NOILER_ADVISORY_PLAYBOOK: PoultryPlaybook = {
  batchType: 'noiler',
  rules: [
    {
      ruleKey: 'noiler.day1.brooding',
      offsetDays: 1,
      happeningNow: 'The brooding week has started.',
      whatNext: 'Check heat, litter dryness, and starter feed access.',
      needQuery: 'poultry starter feed electrolytes chicks',
      notifyRoles: ['field_worker', 'supervisor'],
      reasonCode: 'poultry_brooding',
    },
    {
      ruleKey: 'noiler.day7.gumboro',
      offsetDays: 7,
      happeningNow: 'Gumboro vaccination window is due.',
      whatNext: 'Confirm Gumboro vaccine with your vet/agrovet and schedule the dose.',
      needQuery: 'Gumboro vaccine poultry',
      notifyRoles: ['supervisor', 'owner'],
      reasonCode: 'poultry_vaccination',
    },
    {
      ruleKey: 'noiler.day14.newcastle',
      offsetDays: 14,
      happeningNow: 'Newcastle booster window is approaching.',
      whatNext: 'Plan Lasota booster and review mortality logs.',
      needQuery: 'Newcastle Lasota vaccine poultry',
      notifyRoles: ['supervisor', 'owner'],
      reasonCode: 'poultry_vaccination',
    },
    {
      ruleKey: 'noiler.day21.litter',
      offsetDays: 21,
      happeningNow: 'Mid-cycle litter and feed check.',
      whatNext: 'Refresh wet litter and switch toward grower feed if advised.',
      needQuery: 'grower feed litter poultry',
      notifyRoles: ['field_worker', 'supervisor'],
      reasonCode: 'poultry_litter_feed',
    },
    {
      ruleKey: 'noiler.day28.closeout',
      offsetDays: 28,
      happeningNow: 'Pre-closeout health window.',
      whatNext: 'Review flock health and prepare for closeout logistics.',
      needQuery: 'poultry disinfectant farm biosecurity',
      notifyRoles: ['supervisor', 'owner'],
      reasonCode: 'poultry_closeout',
    },
  ],
}

/** The columns of a `livestock_schedule_entries` row the advisory layer reads. */
export type BatchScheduleEntry = {
  /** Days after the batch's `acquiredAt`. */
  dayOffset: number
  name: string
  vaccine: string | null
  /**
   * Anything but 'done' means canonicalization has not succeeded yet and
   * `name` / `vaccine` may still hold the language they were written in.
   */
  translationStatus: 'done' | 'pending' | 'failed'
}

/** Long enough for a vaccine or a task name, short enough for a WhatsApp line. */
const SCHEDULE_SUBJECT_MAX_CHARS = 80

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, SCHEDULE_SUBJECT_MAX_CHARS)
}

/**
 * Free text folded to a machine form: no diacritics, no case, no punctuation.
 *
 * Not `foldForMatch` from the crop lexicon, which this file cannot import —
 * `crop-normalize.ts` reads `CROP_ADVISORY_PLAYBOOKS` from here while it loads.
 * The two are allowed to differ because nothing below is a lexicon lookup: this
 * builds a rule key and scans for a word.
 */
function foldText(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Vaccination wording in every language a schedule row can still be sitting in.
 *
 * A row whose canonicalization has not run yet is matched here too: the framing
 * this picks decides who is paged, and a jab has to reach the supervisor and the
 * owner whatever language the row was written in.
 */
const VACCINATION_WORDS = ['vaccin', 'booster', 'ajesara', 'jab']

function isVaccinationEntry(entry: BatchScheduleEntry): boolean {
  if (entry.vaccine?.trim()) return true
  const name = foldText(entry.name)
  return VACCINATION_WORDS.some((word) => name.includes(word))
}

/**
 * The playbook rule a schedule entry borrows its framing from.
 *
 * A schedule row carries a day, a name and sometimes a vaccine. It has no
 * `reasonCode` and no `notifyRoles`, and neither is cosmetic: the reason code is
 * the key into the pre-translated fallbacks in `advisory-fallback-messages.ts`,
 * which are the only thing a non-English reader gets when the LLM is down, and
 * the roles decide who is notified. Deriving either from free text per row would
 * put unvalidated strings where fixed keys belong, so the row supplies the
 * timing and the subject and the playbook keeps supplying the framing.
 *
 * A vaccination only borrows from a vaccination rule and a husbandry task only
 * from a husbandry one, so a jab scheduled on day 35 still reaches the
 * supervisor and the owner instead of being framed as a close-out. Within that
 * split the nearest offset wins, which puts an early task in brooding framing
 * and a late one in close-out framing.
 */
function framingFor(entry: BatchScheduleEntry): AdvisoryRuleDef {
  const wantsVaccination = isVaccinationEntry(entry)
  const pool = NOILER_ADVISORY_PLAYBOOK.rules.filter(
    (rule) => (rule.reasonCode === 'poultry_vaccination') === wantsVaccination,
  )
  const candidates = pool.length > 0 ? pool : NOILER_ADVISORY_PLAYBOOK.rules
  return candidates.reduce((best, rule) =>
    Math.abs(rule.offsetDays - entry.dayOffset) < Math.abs(best.offsetDays - entry.dayOffset)
      ? rule
      : best,
  )
}

/**
 * Rule key for a schedule entry: its day and its subject, never its row id.
 *
 * `advisory_recommendations` dedupes on (farm, source, ruleKey), so the key has
 * to survive a batch's calendar being regenerated. Regeneration writes fresh
 * uuids for the same dates, and an id-keyed recommendation would then fire the
 * entire schedule at the farm a second time. Day plus subject describes what the
 * farmer is being told, so an unchanged calendar stays quiet and a corrected
 * date or a renamed task is a genuinely new thing to say.
 */
function scheduleRuleKey(entry: BatchScheduleEntry, subject: string): string {
  const slug = foldText(subject).replace(/ /g, '-').slice(0, 32).replace(/-+$/, '')
  return `noiler.schedule.d${entry.dayOffset}.${slug || 'task'}`
}

function vaccineNeedQuery(vaccine: string): string {
  const named = foldText(vaccine).includes('vaccine') ? vaccine : `${vaccine} vaccine`
  return `${named} poultry agrovet`
}

function scheduleRule(entry: BatchScheduleEntry): AdvisoryRuleDef {
  const framing = framingFor(entry)
  const name = oneLine(entry.name)
  const vaccine = entry.vaccine ? oneLine(entry.vaccine) : null
  const ruleKey = scheduleRuleKey(entry, vaccine ?? name)

  // The locale trio on the row is the only evidence that its words are English.
  // Until it reads 'done' they may not be, and a recommendation payload is a
  // canonical-English column, so an unsettled row contributes its day and
  // nothing else. The translation retry job repairs the row later, and the
  // specific line arrives then under a key the new subject makes new.
  if (entry.translationStatus !== 'done') {
    return { ...framing, ruleKey, offsetDays: entry.dayOffset }
  }

  return {
    ruleKey,
    offsetDays: entry.dayOffset,
    happeningNow: `${name} is due on day ${entry.dayOffset} of this cycle.`,
    whatNext: vaccine
      ? `Confirm ${vaccine} with your vet/agrovet and give the scheduled dose.`
      : `Carry out ${name} today and record what was done.`,
    needQuery: vaccine ? vaccineNeedQuery(vaccine) : framing.needQuery,
    notifyRoles: framing.notifyRoles,
    reasonCode: framing.reasonCode,
  }
}

/**
 * The rules a poultry batch is advised off.
 *
 * A batch that has rows in `livestock_schedule_entries` is advised off its own
 * calendar and off nothing else. Those dates were written for this batch's breed
 * and start date and the farm can correct them, so an offset hard-coded in this
 * file must neither override them nor be merged in alongside them — a farm that
 * moved Gumboro to day 10 would otherwise still be told day 7. The playbook is
 * what a batch gets when it has no calendar at all.
 */
export function poultryRulesForBatch(
  entries: readonly BatchScheduleEntry[],
): AdvisoryRuleDef[] {
  if (entries.length === 0) return NOILER_ADVISORY_PLAYBOOK.rules
  return entries.map(scheduleRule)
}

/** The columns of a `crop_cycle_tasks` row the advisory layer reads. */
export type CropCycleTaskEntry = {
  stage: CropStage
  /**
   * Days after the cycle entered `stage`, not after planting. The number only
   * means anything while the cycle is in that stage.
   */
  offsetDays: number
  templateName: string
  description: string | null
  /**
   * Anything but 'done' means canonicalization has not succeeded yet and
   * `templateName` / `description` may still hold the language they were
   * written in.
   */
  translationStatus: 'done' | 'pending' | 'failed'
}

/** The parts of a `crop_cycles` row that say what its advisories are about. */
export type AdvisableCropCycle = {
  cropType: string
  stage: CropStage
}

/**
 * The fallback rules the generic table holds for a crop at a stage.
 *
 * Empty for every crop the table does not cover, which is most of them, and
 * empty for germination and harvested, which it covers for nobody.
 */
function playbookRulesForCycle(cycle: AdvisableCropCycle): AdvisoryRuleDef[] {
  return CROP_ADVISORY_PLAYBOOKS.filter(
    (playbook) =>
      playbook.cropType === cycle.cropType.toLowerCase() && playbook.stage === cycle.stage,
  ).flatMap((playbook) => playbook.rules)
}

type CropTaskFraming = {
  rule: AdvisoryRuleDef
  /** Whether that rule was written for the crop this cycle is actually growing. */
  ownCrop: boolean
}

/**
 * The playbook rule a crop task borrows its framing from.
 *
 * A task row carries a stage, a day and some words. It has no `reasonCode` and
 * no `notifyRoles`, and neither is cosmetic: the reason code is the key into the
 * pre-translated fallbacks in `advisory-fallback-messages.ts`, which are the
 * only thing a non-English reader gets when the LLM is down, and the roles
 * decide who is notified. Deriving either from free text per row would put
 * unvalidated strings where fixed keys belong, so the row supplies the timing
 * and the subject and the playbook keeps supplying the framing.
 *
 * The stage is what the framing is really about — the reason codes are stage
 * shaped (`crop_stage_flowering`, `crop_stage_harvest_prep`) and deliberately
 * name no crop — so a task borrows from its own stage first and only then from
 * anywhere. Within a stage the cycle's own crop is preferred, and after that the
 * nearest offset wins, which puts early work in early framing and late work in
 * harvest framing.
 */
function cropTaskFraming(cycle: AdvisableCropCycle, task: CropCycleTaskEntry): CropTaskFraming {
  const cropType = cycle.cropType.toLowerCase()
  const all = CROP_ADVISORY_PLAYBOOKS.flatMap((playbook) =>
    playbook.rules.map((rule) => ({
      rule,
      stage: playbook.stage,
      ownCrop: playbook.cropType === cropType,
    })),
  )
  const atStage = all.filter((candidate) => candidate.stage === task.stage)
  const ownAtStage = atStage.filter((candidate) => candidate.ownCrop)
  const pool = ownAtStage.length > 0 ? ownAtStage : atStage.length > 0 ? atStage : all
  const nearest = pool.reduce((best, candidate) =>
    Math.abs(candidate.rule.offsetDays - task.offsetDays) <
    Math.abs(best.rule.offsetDays - task.offsetDays)
      ? candidate
      : best,
  )
  return { rule: nearest.rule, ownCrop: nearest.ownCrop }
}

/**
 * Rule key for a crop task: its stage, its day and its subject, never its row id.
 *
 * `advisory_recommendations` dedupes on (farm, source, ruleKey), so the key has
 * to survive a cycle's plan being regenerated. Regeneration writes fresh uuids
 * for the same work, and an id-keyed recommendation would then fire the whole
 * plan at the farm a second time. Stage plus day plus subject describes what the
 * farmer is being told, so an unchanged plan stays quiet and a moved date or a
 * renamed task is a genuinely new thing to say. The stage is in the key because
 * the day is counted from stage entry, so the same day number recurs in every
 * stage of the cycle.
 */
function cropTaskRuleKey(task: CropCycleTaskEntry, subject: string): string {
  const slug = foldText(subject).replace(/ /g, '-').slice(0, 32).replace(/-+$/, '')
  return `crop.plan.${task.stage}.d${task.offsetDays}.${slug || 'task'}`
}

/** Enum member to prose, for the one place a stage is read out to a farmer. */
function stageWords(stage: CropStage): string {
  return stage.replace(/_/g, ' ')
}

/** Descriptions come from a generator and from farmers; only some end in a stop. */
function endSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/**
 * What to search the marketplace for.
 *
 * Not the framing rule's `needQuery`: those name the crop they were written for
 * ("organic fertilizer compost plantain"), so borrowing one across crops shops
 * the wrong shelf. The cycle's own crop plus the row's own subject describes the
 * purchase without asserting anything the row did not say.
 */
function cropNeedQuery(cropType: string, subject: string | null): string {
  const crop = oneLine(cropType)
  if (!subject) return crop ? `${crop} farm inputs` : 'farm inputs'
  if (!crop || foldText(subject).includes(foldText(crop))) return `${subject} farm`
  return `${subject} ${crop} farm`
}

function cropTaskRule(cycle: AdvisableCropCycle, task: CropCycleTaskEntry): AdvisoryRuleDef {
  const { rule: framing, ownCrop } = cropTaskFraming(cycle, task)
  const name = oneLine(task.templateName)
  const ruleKey = cropTaskRuleKey(task, name)

  // The locale trio on the row is the only evidence that its words are English.
  // Until it reads 'done' they may not be, and a recommendation payload is a
  // canonical-English column, so an unsettled row contributes its day and
  // nothing else. The translation retry job repairs the row later, and the
  // specific line arrives then under a key the new subject makes new.
  if (task.translationStatus !== 'done') {
    // Falling back to the framing's own sentences is only honest when it was
    // written for this crop. A cassava cycle borrowing plantain's stage framing
    // must not be told about plantain, so it gets the reason code's generic
    // line instead — which is already the sentence a French reader gets for
    // this rule, so the two languages agree rather than diverge.
    const seed = ownCrop ? ruleSeed(framing) : renderAdvisoryFallback(framing.reasonCode, 'en')
    return {
      ...framing,
      ...seed,
      ruleKey,
      offsetDays: task.offsetDays,
      needQuery: ownCrop ? framing.needQuery : cropNeedQuery(cycle.cropType, null),
    }
  }

  const description = task.description?.trim() ? oneLine(task.description) : null
  return {
    ruleKey,
    offsetDays: task.offsetDays,
    happeningNow: `${name} is due on day ${task.offsetDays} of the ${stageWords(task.stage)} stage.`,
    whatNext: description
      ? `${endSentence(description)} Record what was done.`
      : `Carry out ${name} today and record what was done.`,
    needQuery: cropNeedQuery(cycle.cropType, name),
    notifyRoles: framing.notifyRoles,
    reasonCode: framing.reasonCode,
  }
}

/**
 * The rules a crop cycle is advised off.
 *
 * A cycle that has rows in `crop_cycle_tasks` is advised off its own plan and
 * off nothing else. Those dates were written for this cycle's crop and the day
 * each stage was actually reached, and the farm can correct them, so an offset
 * hard-coded in this file must neither override them nor be merged in alongside
 * them — a farm that moved its fertiliser pass to day 60 would otherwise still
 * be told day 45. The playbook is what a cycle gets when it has no plan at all.
 *
 * A plan that says nothing about the current stage means nothing is scheduled
 * there, not that the playbook may fill the gap: the work may have been taken
 * out on purpose. Tasks of other stages are held back rather than dropped
 * because `offsetDays` is counted from stage entry, so their day is not
 * comparable to this stage's day until the cycle reaches them.
 */
export function cropRulesForCycle(
  cycle: AdvisableCropCycle,
  tasks: readonly CropCycleTaskEntry[],
): AdvisoryRuleDef[] {
  if (tasks.length === 0) return playbookRulesForCycle(cycle)
  return tasks
    .filter((task) => task.stage === cycle.stage)
    .map((task) => cropTaskRule(cycle, task))
}

export const WEATHER_ADVISORY_RULES: WeatherAdvisoryRuleDef[] = [
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
