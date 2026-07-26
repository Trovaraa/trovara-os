/**
 * Match a name a worker typed against the farm's own rows — plots, zones,
 * inventory items, livestock batches, assets.
 *
 * Workers type what a phone keyboard makes easy: "Bloc Nord" for a plot stored
 * as "Bloc-Nord", "pepiniere" for "Pépinière", "noiler  a" with a stray double
 * space. A raw `toLowerCase()` comparison misses all of those, and a missed name
 * is a Butler command that produces no draft and no error — the worker sends a
 * message and simply gets nothing back.
 *
 * Matching only. The fold is applied to both sides of the comparison and never
 * to a value that is written or displayed: the row keeps the spelling the farm
 * chose, and replies keep quoting it.
 *
 * Different job from `crop-normalize.ts` / `species-normalize.ts`, which map
 * free text onto a fixed developer-authored lexicon (`cropType`, `species`) and
 * must not be routed through here: there is no canonical set of plot names to
 * resolve to, only the rows this farm created. The fold is the one thing shared,
 * so it is imported from the lexicon rather than written again.
 */
import { foldForMatch } from './crop-normalize.js'

export type NameMatch<T> =
  /** Exactly one row answers to the name. */
  | { status: 'matched'; row: T }
  /** No row answers to the name. */
  | { status: 'none' }
  /** Two differently-spelled rows fold to the same name; `rows` are the candidates. */
  | { status: 'ambiguous'; rows: T[] }

/** The name-bearing fields of a row, in the order they should be compared. */
type NamesOf<T> = (row: T) => readonly (string | null | undefined)[]

/**
 * The distinct stored spellings among `rows` that fold to `folded`.
 *
 * Byte-identical names are one spelling: a farm with two rows both called
 * "Pen A" gives the worker nothing to retype differently, so that is not
 * ambiguity worth reporting — only genuinely different spellings are.
 */
function matchingSpellings<T>(
  rows: readonly T[],
  namesOf: NamesOf<T>,
  folded: string,
): Set<string> {
  const spellings = new Set<string>()
  for (const row of rows) {
    for (const name of namesOf(row)) {
      const trimmed = name?.trim()
      if (trimmed && foldForMatch(trimmed) === folded) spellings.add(trimmed)
    }
  }
  return spellings
}

/**
 * Resolve `query` against `rows` in two tiers: the name exactly as stored
 * first, then the folded form.
 *
 * Exact-first matters for a farm that deliberately keeps two rows whose names
 * differ only in accents, hyphens or case ("Bloc-Nord" beside "Bloc Nord"):
 * typing either one exactly still addresses that row and nothing else. Only the
 * folded tier can be ambiguous, and it reports the candidates instead of taking
 * the first: the two rows are different places, and logging feed or a stock
 * move against the wrong one is a worse outcome than asking the worker to type
 * the name as it is written.
 */
export function matchByName<T>(
  rows: readonly T[],
  query: string,
  namesOf: NamesOf<T>,
): NameMatch<T> {
  const typed = (query ?? '').trim()
  if (!typed) return { status: 'none' }

  const exact = rows.find((row) => namesOf(row).some((name) => name?.trim() === typed))
  if (exact) return { status: 'matched', row: exact }

  const folded = foldForMatch(typed)
  // A query of only punctuation folds to nothing and would match any row whose
  // name also folds to nothing.
  if (!folded) return { status: 'none' }

  const hits = rows.filter((row) =>
    namesOf(row).some((name) => {
      const candidate = name?.trim()
      return !!candidate && foldForMatch(candidate) === folded
    }),
  )
  if (hits.length === 0) return { status: 'none' }
  if (hits.length === 1) return { status: 'matched', row: hits[0] }
  if (matchingSpellings(hits, namesOf, folded).size <= 1) return { status: 'matched', row: hits[0] }
  return { status: 'ambiguous', rows: hits }
}

/**
 * The row a match resolves to, or null.
 *
 * Ambiguity collapses to null on purpose: every caller already answers a miss
 * with "not found - use the exact name from ...", which is the right thing to
 * tell a worker whose two plots fold together, and the alternative is picking
 * one of them for him. Callers that want to say more can read the
 * `matchByName` result directly.
 */
export function matchedRow<T>(match: NameMatch<T>): T | null {
  return match.status === 'matched' ? match.row : null
}

/** Resolve a query against rows carrying a single `name` column. */
export function findByName<T extends { name: string }>(
  rows: readonly T[],
  query: string,
): T | null {
  return matchedRow(matchByName(rows, query, (row) => [row.name]))
}
