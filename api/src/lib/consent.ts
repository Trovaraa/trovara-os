import { z } from 'zod'

// Single source of truth for the consent contract. The frontend reads the
// current version and required types from `/api/consent/status` instead of
// hardcoding them, so the client and server can never drift. Bump the version
// when the privacy / data-processing terms change to force re-acceptance.
export const CONSENT_TYPES = ['privacy', 'data_processing'] as const
export type ConsentType = (typeof CONSENT_TYPES)[number]
export const CURRENT_CONSENT_VERSION = '2026-01'

export const consentPostSchema = z.object({
  consentType: z.enum(CONSENT_TYPES),
  version: z.string().min(1).max(20),
})

export type ConsentRow = {
  consentType: string
  version: string
  acceptedAt: Date
  userId: string
}

export type ConsentStatus = {
  acceptedLatest: boolean
  currentVersion: string
  requiredTypes: ConsentType[]
  latest: Array<{
    consentType: ConsentType
    version: string | null
    acceptedByCurrentUser: boolean
  }>
}

/**
 * Derives consent status from consent records for a farm.
 *
 * `rows` must be ordered newest-first (by `acceptedAt` desc). A type counts as
 * accepted only when the most recent record was created by the current user AND
 * matches the current version - so a version bump correctly forces re-consent.
 */
export function computeConsentStatus(rows: ConsentRow[], userId: string): ConsentStatus {
  const latestByType = new Map<string, ConsentRow>()
  for (const row of rows) {
    if (!latestByType.has(row.consentType)) latestByType.set(row.consentType, row)
  }

  const latest = CONSENT_TYPES.map((consentType) => {
    const row = latestByType.get(consentType)
    return {
      consentType,
      version: row?.version ?? null,
      acceptedByCurrentUser:
        row?.userId === userId && row?.version === CURRENT_CONSENT_VERSION,
    }
  })

  return {
    acceptedLatest: latest.every((entry) => entry.acceptedByCurrentUser),
    currentVersion: CURRENT_CONSENT_VERSION,
    requiredTypes: [...CONSENT_TYPES],
    latest,
  }
}
