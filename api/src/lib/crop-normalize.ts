/**
 * Crop-name lexicon: worker spelling in any supported language → the exact
 * canonical key the generic fallback playbook is filed under.
 *
 * `cropType` is stored as free text and matched as a dictionary key
 * (`playbook.cropType === cycle.cropType.toLowerCase()`). The keys are English,
 * so a French or Yoruba crop name matches nothing and the cycle silently gets
 * no fallback tips — no error, the feature just does nothing.
 *
 * That is the whole of this file's job, and it is a narrow one. A cycle carries
 * its own agronomy in `crop_cycle_stages` and `crop_cycle_tasks`, generated from
 * whatever the farmer typed, and it is advised off those rows whatever its crop
 * name reads as. What canonicalizing buys is the fallback: a cycle with no plan
 * of its own is advised off `CROP_ADVISORY_PLAYBOOKS`, and only an exact key
 * reaches it. So a miss here costs a cycle its fallback, not its advisories,
 * which is the same shape the species test has on the poultry side.
 *
 * This is a table and not an LLM call on purpose, and that holds however narrow
 * the job is. The lookup needs one exact string, and a translator is free to
 * return any correct synonym: "noix de coco" may come back as "coconut"
 * (matches) or "coconut palm" (silently matches nothing), which is the same
 * silent failure with extra cost and latency. The canonical set is tiny, so a
 * table is total: no cost, no latency, and it works with the LLM switched off.
 *
 * Adding a fallback playbook for a new crop adds its key to
 * `CANONICAL_CROP_TYPES` and the coverage test then fails until aliases for all
 * four languages are added here.
 */
import { CROP_ADVISORY_PLAYBOOKS } from './advisory-playbooks.js'
import type { ReplyLocale } from './reply-locale.js'

/**
 * Every key the fallback playbook can be reached by, read off the playbook
 * itself so this file cannot drift from it or invent a key nothing matches.
 */
export const CANONICAL_CROP_TYPES: readonly string[] = [
  ...new Set(CROP_ADVISORY_PLAYBOOKS.map((playbook) => playbook.cropType)),
].sort()

/**
 * Aliases per canonical key per language, written the way a worker types them.
 * Matching folds case, whitespace, punctuation and diacritics, so an accented
 * entry here also covers the unaccented spelling ("àgbọn" covers "agbon") and
 * only genuinely different words need their own entry.
 *
 * Pidgin is English-lexified, so it repeats the English spellings and adds the
 * phonetic ones.
 */
export const CROP_ALIASES: Readonly<
  Record<string, Readonly<Record<ReplyLocale, readonly string[]>>>
> = {
  plantain: {
    en: [
      'plantain',
      'plantains',
      'plantain banana',
      'banana plantain',
      'plaintain',
      'platain',
      'plantin',
      'plantan',
    ],
    fr: [
      'plantain',
      'plantains',
      'banane plantain',
      'bananes plantains',
      'banane à cuire',
      'bananier plantain',
    ],
    // Bare "ọgẹdẹ" is banana in general, not plantain, so it is left out: a
    // banana cycle with no plan of its own would then be handed plantain's
    // fallback dates under its own name, which is worse than no fallback.
    yo: ['ọgẹdẹ àgbagbà', 'àgbagbà'],
    pcm: ['plantain', 'plantin', 'plaintain', 'plantain banana'],
  },
  coconut: {
    en: [
      'coconut',
      'coconuts',
      'coco nut',
      'coconut palm',
      'coconut tree',
      'cocnut',
      'cocunut',
      'cocoanut',
    ],
    fr: ['noix de coco', 'noix de cocos', 'coco', 'cocotier', 'cocotiers'],
    yo: ['àgbọn', 'eso àgbọn'],
    pcm: ['coconut', 'coco nut', 'kokonut', 'kokonat'],
  },
}

/**
 * Fold a name to its match form: strip diacritics, lowercase, turn separators
 * into single spaces and drop punctuation. Used on both sides of the lookup,
 * never on the value we store.
 *
 * Exported because entity-name matching (`entity-name-match.ts`) has to fold
 * exactly the way this lexicon does. A second implementation there would let
 * the two drift, and a fold that differs by one character is a lookup that
 * silently misses.
 */
export function foldForMatch(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const ALIAS_TO_CANONICAL: ReadonlyMap<string, string> = new Map(
  Object.entries(CROP_ALIASES).flatMap(([canonical, byLocale]) =>
    Object.values(byLocale)
      .flat()
      .map((alias) => [foldForMatch(alias), canonical] as const),
  ),
)

const CANONICAL_SET = new Set(CANONICAL_CROP_TYPES)

export type CropTypeMatch = {
  /** The exact lookup key when matched, otherwise the input untouched. */
  canonical: string
  matched: boolean
}

/**
 * Resolve a worker-written crop name to its canonical lookup key.
 *
 * Unmatched input passes through unchanged: a farm growing something we have no
 * fallback playbook for is normal — it still gets a plan of its own and the
 * advisories that come off it — and storing what the worker wrote keeps the crop
 * readable everywhere it is displayed. A canonical key is only returned when the
 * playbook actually defines it, so this can never hand it a key it cannot
 * resolve.
 */
export function normalizeCropType(raw: string): CropTypeMatch {
  const folded = foldForMatch(raw ?? '')
  const singular = folded.endsWith('s') ? folded.slice(0, -1) : null
  const hit =
    ALIAS_TO_CANONICAL.get(folded) ?? (singular ? ALIAS_TO_CANONICAL.get(singular) : undefined)
  if (hit && CANONICAL_SET.has(hit)) return { canonical: hit, matched: true }
  return { canonical: raw, matched: false }
}
