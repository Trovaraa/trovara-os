import { describe, expect, it } from 'vitest'
import {
  CURRENT_CONSENT_VERSION,
  computeConsentStatus,
  consentPostSchema,
  type ConsentRow,
} from './consent.js'

const userId = 'user-1'
const otherUserId = 'user-2'

function row(
  consentType: string,
  version: string,
  acceptedBy: string = userId,
): ConsentRow {
  return {
    consentType,
    version,
    acceptedAt: new Date('2026-01-15T12:00:00Z'),
    userId: acceptedBy,
  }
}

describe('computeConsentStatus', () => {
  it('requires both types at the current version for acceptedLatest', () => {
    const status = computeConsentStatus(
      [row('privacy', CURRENT_CONSENT_VERSION), row('data_processing', CURRENT_CONSENT_VERSION)],
      userId,
    )

    expect(status.acceptedLatest).toBe(true)
    expect(status.currentVersion).toBe(CURRENT_CONSENT_VERSION)
    expect(status.requiredTypes).toEqual(['privacy', 'data_processing'])
  })

  it('rejects stale versions so policy bumps force re-consent', () => {
    const status = computeConsentStatus(
      [row('privacy', '2025-12'), row('data_processing', CURRENT_CONSENT_VERSION)],
      userId,
    )

    expect(status.acceptedLatest).toBe(false)
    expect(status.latest.find((entry) => entry.consentType === 'privacy')?.acceptedByCurrentUser).toBe(
      false,
    )
  })

  it('ignores consent recorded by another user on the farm', () => {
    const status = computeConsentStatus(
      [
        row('privacy', CURRENT_CONSENT_VERSION, otherUserId),
        row('data_processing', CURRENT_CONSENT_VERSION, otherUserId),
      ],
      userId,
    )

    expect(status.acceptedLatest).toBe(false)
  })

  it('uses the newest record per consent type when rows are newest-first', () => {
    const status = computeConsentStatus(
      [
        row('privacy', CURRENT_CONSENT_VERSION),
        row('privacy', '2025-12'),
        row('data_processing', CURRENT_CONSENT_VERSION),
      ],
      userId,
    )

    expect(status.acceptedLatest).toBe(true)
    expect(status.latest.find((entry) => entry.consentType === 'privacy')?.version).toBe(
      CURRENT_CONSENT_VERSION,
    )
  })
})

describe('consentPostSchema', () => {
  it('accepts the login consent payload shape', () => {
    expect(
      consentPostSchema.parse({
        consentType: 'privacy',
        version: CURRENT_CONSENT_VERSION,
      }),
    ).toEqual({
      consentType: 'privacy',
      version: CURRENT_CONSENT_VERSION,
    })
  })

  it('rejects the legacy login payload that broke sign-in', () => {
    expect(() =>
      consentPostSchema.parse({
        accepted: true,
        channel: 'login',
      }),
    ).toThrow()
  })
})
