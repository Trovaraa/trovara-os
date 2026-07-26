import { useI18n } from 'vue-i18n'

/**
 * Why the API generated no plan. Null once the batch or cycle has one. Union of
 * AgronomySkipReason in api/src/lib/poultry-agronomy.ts and
 * CropAgronomySkipReason in api/src/lib/crop-agronomy.ts; only batches can be
 * skipped for their species.
 */
export type AgronomySkipReason =
  | 'species_unsupported'
  | 'llm_unavailable'
  | 'budget_exhausted'
  | 'llm_failed'
  | 'invalid_payload'
  | 'write_failed'

/**
 * llm_failed, invalid_payload and write_failed differ only to the API; the farm
 * is told the same thing about all three.
 */
const AGRONOMY_SKIP_KEYS: Record<AgronomySkipReason, string> = {
  species_unsupported: 'agronomy.skipSpecies',
  llm_unavailable: 'agronomy.skipUnavailable',
  budget_exhausted: 'agronomy.skipBudget',
  llm_failed: 'agronomy.skipFailed',
  invalid_payload: 'agronomy.skipFailed',
  write_failed: 'agronomy.skipFailed',
}

/** Renders the reason code the API stores on a batch or crop cycle. */
export function useAgronomySkipText() {
  const { t } = useI18n()

  /**
   * Why this batch or cycle has no plan, in words. Empty for one nobody has
   * tried to make a plan for, which the empty-state line already covers, and
   * for a reason code newer than this build rather than the code itself.
   */
  function agronomySkipText(reason: AgronomySkipReason | null): string {
    const key = reason ? AGRONOMY_SKIP_KEYS[reason] : undefined
    return key ? t(key) : ''
  }

  return { agronomySkipText }
}
