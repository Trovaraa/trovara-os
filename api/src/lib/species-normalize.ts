/**
 * Livestock species lexicon: worker spelling in any supported language → the
 * canonical poultry batch type the livestock features gate on.
 *
 * `species` is stored as free text but read as a lookup key, and two different
 * forms of that read were in the tree at the same time:
 * `species.toLowerCase() === 'broiler'` in the livestock routes and
 * `species.toLowerCase().includes('broiler')` in the advisory layer. One row
 * therefore got two answers — "Broiler chicken" collected advisory tips and a
 * 400 "Vaccination schedule only available for broiler batches" from the same
 * data, with no error anywhere. A French, Yoruba or Pidgin name matched neither
 * form, so the feature silently did nothing.
 *
 * The canonical values are the `poultry_batch_type` enum members, which already
 * say exactly what those string matches were groping for. Writes resolve the
 * enum from the species the worker typed, so `batchType` becomes the source of
 * truth and the string match survives only as a tolerant fallback for rows
 * written before this file existed.
 *
 * This is a table and not an LLM call on purpose. The consumer needs one exact
 * value, and a translator is free to return any correct synonym: "poule
 * pondeuse" may come back as "layer" (matches) or "laying hen" / "egg bird"
 * (silently matches nothing), which is the same silent failure with cost and
 * latency added. Today's behaviour for an unrecognized species is a clean miss,
 * which is already safe, so a model could only turn a safe miss into a
 * confident wrong answer that is indistinguishable from a correct one at a bare
 * dictionary lookup. The canonical set is tiny, so a table is total: no cost, no
 * latency, it works with the LLM switched off, and a species field cannot carry
 * a prompt injection into a model.
 *
 * Adding a poultry type to the enum adds it to `CANONICAL_SPECIES`, and the
 * coverage test then fails until aliases for all four languages are written.
 */
import { poultryBatchTypeEnum } from '../db/schema.js'
import { NOILER_ADVISORY_PLAYBOOK } from './advisory-playbooks.js'
import { foldForMatch } from './crop-normalize.js'
import type { ReplyLocale } from './reply-locale.js'

export type PoultryBatchType = (typeof poultryBatchTypeEnum.enumValues)[number]

/**
 * The catch-all enum member. It is a label for "none of the above", not a name
 * anyone types, so nothing may resolve to it: a species we cannot place stays
 * unclassified instead of being asserted to be poultry.
 */
const CATCH_ALL_BATCH_TYPE: PoultryBatchType = 'other'

/** The playbook names the batch type it applies to; don't restate it as a literal. */
const NOILER: PoultryBatchType = NOILER_ADVISORY_PLAYBOOK.batchType

/**
 * Every poultry type the batch-type enum can express, read from the enum itself
 * so this file cannot drift from it or invent a value the column rejects.
 *
 * A matched species is stored as its canonical value, which is the same string
 * as the enum member, so the free-text field and the enum agree by construction.
 */
export const CANONICAL_SPECIES: readonly PoultryBatchType[] = [
  ...poultryBatchTypeEnum.enumValues,
]
  .filter((value) => value !== CATCH_ALL_BATCH_TYPE)
  .sort()

/**
 * Aliases per canonical value per language, written the way a worker types them,
 * misspellings included. Matching folds case, whitespace, separators,
 * punctuation and diacritics, so an accented entry here also covers the
 * unaccented spelling ("adìẹ ẹyin" covers "adie eyin") and only genuinely
 * different words need their own entry.
 *
 * Pidgin is English-lexified, so it repeats the English spellings and adds the
 * phonetic ones. Yoruba poultry talk borrows the English words too, so they are
 * listed there as well: leaving them out would fail the worker who mixes them,
 * which is what workers do.
 *
 * Bare generic words for "chicken" are deliberately absent — "poulet",
 * "adìẹ", "fowl" name the animal, not the production type, and guessing a
 * production type from them would attach the wrong calendar to a laying flock.
 * They live in `GENERIC_POULTRY_TERMS` below, which turns them into a question
 * instead.
 *
 * Broiler spellings are absent on purpose, not by oversight: this farm keeps
 * Noilers, and the two are different birds on different cycles. "broiler" now
 * falls through unmatched, which leaves the species readable as typed and the
 * batch unclassified — the honest answer — rather than quietly filing a meat
 * bird as a dual-purpose one.
 */
export const SPECIES_ALIASES: Readonly<
  Record<string, Readonly<Record<ReplyLocale, readonly string[]>>>
> = {
  noiler: {
    en: [
      'noiler',
      'noilers',
      'noiler chicken',
      'noiler chickens',
      'noiler chick',
      'noiler chicks',
      'noiler bird',
      'noiler birds',
      'dual purpose chicken',
      'dual purpose bird',
      // Worker spellings seen in the field.
      'noila',
      'noilas',
      'noyler',
      'noiller',
      'nolier',
    ],
    fr: [
      // Noiler is a breed name rather than a French word, so it is written as
      // heard. The generic French terms are for the farm that describes the
      // bird instead of naming it.
      'noiler',
      'poulet noiler',
      'poulets noiler',
      'poulet a double fin',
      'poulets a double fin',
      'poulet mixte',
    ],
    yo: ['adìẹ noiler', 'noiler', 'noila'],
    pcm: ['noiler', 'noila', 'noiler fowl', 'noila fowl'],
  },
  layer: {
    en: [
      'layer',
      'layers',
      'layer chicken',
      'layer chickens',
      'layer hen',
      'layer hens',
      'laying hen',
      'laying hens',
      'layer bird',
      'layer birds',
      'egg layer',
      'egg layers',
      'laiyer',
      'layar',
    ],
    fr: [
      'poule pondeuse',
      'poules pondeuses',
      'pondeuse',
      'pondeuses',
      'poule de ponte',
      'poules de ponte',
      'poule ponte',
    ],
    yo: ['adìẹ ẹyin', 'adìẹ tí ń yé ẹyin', 'adìẹ layer', 'layer'],
    pcm: ['layer', 'laya', 'layer fowl', 'egg fowl', 'fowl for egg', 'laying fowl'],
  },
  pullet: {
    en: [
      'pullet',
      'pullets',
      'grower pullet',
      'grower pullets',
      'point of lay pullet',
      'young hen',
      'young hens',
      'pulet',
      'pullete',
      'pullit',
      'polet',
    ],
    fr: [
      'poulette',
      'poulettes',
      'jeune poule',
      'jeunes poules',
      'poulette pondeuse',
      'poulettes pondeuses',
      'poulette prete a pondre',
    ],
    yo: ['adìẹ ọdọ', 'adìẹ ọ̀dọ́mọdé', 'adìẹ pullet', 'pullet'],
    pcm: ['pullet', 'pulet', 'young fowl', 'growing fowl', 'pullet fowl'],
  },
}

/**
 * Words that name poultry without naming a production type.
 *
 * These are the spellings `SPECIES_ALIASES` leaves out on purpose — "fowl",
 * "poulet", "adìẹ" say which animal, not which calendar — collected here so a
 * batch described only in them can be told apart from a batch of goats. Both
 * resolve to no batch type, but only this one is a question worth putting to
 * the farmer.
 *
 * Kept generic on purpose: a word that leans towards one production type
 * belongs in `SPECIES_ALIASES` under that type, not here.
 */
export const GENERIC_POULTRY_TERMS: Readonly<Record<ReplyLocale, readonly string[]>> = {
  en: [
    'chicken',
    'chickens',
    'chick',
    'chicks',
    'bird',
    'birds',
    'fowl',
    'fowls',
    'hen',
    'hens',
    'cock',
    'cockerel',
    'cockerels',
    'poultry',
  ],
  fr: [
    'poulet',
    'poulets',
    'poule',
    'poules',
    'poussin',
    'poussins',
    'volaille',
    'volailles',
    'oiseau',
    'oiseaux',
    'coq',
    'coqs',
  ],
  yo: ['adìẹ', 'ọmọ adìẹ', 'ẹyẹ', 'akùkọ'],
  pcm: ['fowl', 'fowls', 'chicken', 'chikin', 'bird', 'birds', 'agric fowl', 'pikin fowl'],
}

/**
 * Fold a species name to its match form. Shared with the crop lexicon and the
 * entity-name matcher so the three cannot drift; applied to both sides of the
 * lookup, never to the value we store.
 */
const fold = foldForMatch

const ALIAS_TO_CANONICAL: ReadonlyMap<string, PoultryBatchType> = new Map(
  Object.entries(SPECIES_ALIASES).flatMap(([canonical, byLocale]) =>
    Object.values(byLocale)
      .flat()
      .map((alias) => [fold(alias), canonical as PoultryBatchType] as const),
  ),
)

/** Folded aliases per canonical value, for the whole-word scan over legacy rows. */
const FOLDED_ALIASES: ReadonlyMap<PoultryBatchType, readonly string[]> = new Map(
  Object.entries(SPECIES_ALIASES).map(([canonical, byLocale]) => [
    canonical as PoultryBatchType,
    [...new Set(Object.values(byLocale).flat().map(fold))],
  ]),
)

/** Folded generic terms, for the same whole-word scan the aliases get. */
const FOLDED_GENERIC_POULTRY: readonly string[] = [
  ...new Set(Object.values(GENERIC_POULTRY_TERMS).flat().map(fold)),
]

const CANONICAL_SET = new Set<string>(CANONICAL_SPECIES)

export type SpeciesMatch = {
  /** The canonical value when matched, otherwise the input untouched. */
  canonical: string
  matched: boolean
  /** The batch-type enum member to store, or null when we cannot place the species. */
  batchType: PoultryBatchType | null
}

/**
 * Resolve a worker-written species to its canonical poultry value.
 *
 * Unmatched input passes through unchanged: a farm keeping goats, catfish or a
 * breed the enum cannot express ("Kuroiler cockerel") is normal, and storing
 * what the worker wrote keeps it readable everywhere `species` is displayed.
 * A canonical value is only returned when the enum actually defines it, so this
 * can never hand a consumer a value it cannot resolve.
 */
export function normalizeSpecies(raw: string): SpeciesMatch {
  const folded = fold(raw ?? '')
  const singular = folded.endsWith('s') ? folded.slice(0, -1) : null
  const hit =
    ALIAS_TO_CANONICAL.get(folded) ?? (singular ? ALIAS_TO_CANONICAL.get(singular) : undefined)
  if (hit && CANONICAL_SET.has(hit)) return { canonical: hit, matched: true, batchType: hit }
  return { canonical: raw, matched: false, batchType: null }
}

/**
 * Tolerant read: the batch type a species string names, whether or not it was
 * ever normalized.
 *
 * Rows written before the lexicon hold descriptive text — "Noiler (day old)",
 * "500 noiler chicks", "layer hens from Amo" — so an exact-match-only predicate
 * would silently stop advising live flocks. This keeps those rows working by
 * scanning for an alias as a whole word, which is strictly tighter than a raw
 * substring test: "Kuroiler cockerel" is not a noiler.
 *
 * A string naming two types is ambiguous; the first canonical value wins, which
 * is the same answer the old `includes` check gave.
 */
export function resolveBatchTypeFromSpecies(
  raw: string | null | undefined,
): PoultryBatchType | null {
  if (!raw) return null
  const exact = normalizeSpecies(raw)
  if (exact.batchType) return exact.batchType

  const padded = ` ${fold(raw)} `
  if (padded.trim() === '') return null
  for (const canonical of CANONICAL_SPECIES) {
    const aliases = FOLDED_ALIASES.get(canonical) ?? []
    if (aliases.some((alias) => padded.includes(` ${alias} `))) return canonical
  }
  return null
}

/** The options the poultry-type question offers, and the values it accepts back. */
export const POULTRY_TYPE_OPTIONS: readonly PoultryBatchType[] = poultryBatchTypeEnum.enumValues

export type PoultryTypeResolution =
  /** The words name a poultry type the enum can express. */
  | { status: 'resolved'; batchType: PoultryBatchType }
  /** They name poultry but not which kind, which only the farmer can settle. */
  | { status: 'unspecified' }
  /** They name something outside the poultry lexicon: goats, catfish, a pond. */
  | { status: 'unknown' }

/**
 * What a species string says about the batch type, and when it says nothing,
 * why.
 *
 * `normalizeSpeciesForWrite` answers null for "chickens" and for "goats" alike,
 * which is the right value in both cases and the wrong answer to give a worker:
 * the batch type picks the vaccination calendar and the growth curve, so a
 * flock whose words never named one is worth a question, while a goat pen is
 * not poultry and never was.
 */
export function resolvePoultryType(raw: string | null | undefined): PoultryTypeResolution {
  const batchType = resolveBatchTypeFromSpecies(raw)
  if (batchType) return { status: 'resolved', batchType }

  const padded = ` ${fold(raw ?? '')} `
  if (padded.trim() === '') return { status: 'unknown' }
  return FOLDED_GENERIC_POULTRY.some((term) => padded.includes(` ${term} `))
    ? { status: 'unspecified' }
    : { status: 'unknown' }
}

/**
 * The batch type a worker's answer to the poultry-type question names, or null
 * when they wrote something else.
 *
 * The whole message has to be one option and nothing more, so a report that
 * happens to mention a flock ("the layers are off feed") reaches the butler
 * instead of being swallowed as an answer. `other` is only reachable here: the
 * question offers the enum members verbatim, and it is the one value no species
 * name resolves to.
 */
export function matchPoultryTypeAnswer(text: string): PoultryBatchType | null {
  if (fold(text ?? '') === CATCH_ALL_BATCH_TYPE) return CATCH_ALL_BATCH_TYPE
  return normalizeSpecies(text).batchType
}

/** The batch type a stored draft payload carries, or null when it holds none. */
export function asPoultryBatchType(value: unknown): PoultryBatchType | null {
  return (poultryBatchTypeEnum.enumValues as readonly unknown[]).includes(value)
    ? (value as PoultryBatchType)
    : null
}

/**
 * The pair to store for a species the worker typed.
 *
 * `species` stays the worker's words unless it is exactly a name we know, so no
 * detail the farmer typed is destroyed. `batchType` is resolved tolerantly, so a
 * descriptive "Noiler (day old)" is classified as a noiler in the enum while
 * still reading back as the farmer wrote it.
 */
export function normalizeSpeciesForWrite(raw: string): {
  species: string
  batchType: PoultryBatchType | null
} {
  const match = normalizeSpecies(raw)
  return {
    species: match.canonical,
    batchType: match.batchType ?? resolveBatchTypeFromSpecies(raw),
  }
}

/** The parts of a livestock batch row that say what kind of animals it holds. */
export type SpeciesBearingBatch = {
  batchType?: PoultryBatchType | null
  species: string
}

/**
 * The one noiler test. Every consumer — the livestock routes, the advisory
 * engine, the insight builder — must call this so they cannot disagree about
 * the same row again.
 *
 * The enum wins when it is set, because it is the field a write path decided
 * deliberately. Rows that predate the enum leave it null and fall back to the
 * tolerant species read.
 */
export function isNoilerBatch(batch: SpeciesBearingBatch): boolean {
  if (batch.batchType) return batch.batchType === NOILER
  return resolveBatchTypeFromSpecies(batch.species) === NOILER
}

/**
 * Whether this batch holds birds at all, on the same terms as `isNoilerBatch`:
 * the enum first, the species text after. A null batch type is not poultry
 * rather than unknown poultry, because nothing resolves to the catch-all — it
 * is reachable only when a worker says so themselves.
 */
export function isPoultryBatch(batch: SpeciesBearingBatch): boolean {
  if (batch.batchType) return true
  return resolveBatchTypeFromSpecies(batch.species) !== null
}
