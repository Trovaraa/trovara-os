import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => api(...args),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

describe('useSettingsPrivacy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loadPrivacyPanels skips for non-owners', async () => {
    const { useSettingsPrivacy } = await import('./useSettingsPrivacy')
    const privacy = useSettingsPrivacy(() => false)
    await privacy.loadPrivacyPanels()
    expect(api).not.toHaveBeenCalled()
  })

  it('loadPrivacyPanels fetches targets and retention', async () => {
    api
      .mockResolvedValueOnce({ workers: [], contacts: [] })
      .mockResolvedValueOnce({
        config: {
          retentionDays: 90,
          sessionRetentionDays: 30,
          customerContactRetentionDays: 365,
        },
        pendingTaskEvidence: 1,
        pendingExpiredSessions: 0,
        pendingChatMessages: 2,
        pendingContactPhones: 0,
      })
    const { useSettingsPrivacy } = await import('./useSettingsPrivacy')
    const privacy = useSettingsPrivacy(() => true)
    await privacy.loadPrivacyPanels()
    expect(api).toHaveBeenCalledWith('/api/privacy/anonymize-targets')
    expect(api).toHaveBeenCalledWith('/api/privacy/retention-status')
    expect(privacy.retentionStatus.value?.pendingTaskEvidence).toBe(1)
  })

  it('runRetentionNow confirms then posts', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    api
      .mockResolvedValueOnce({
        purgedTaskEvidence: 1,
        purgedExpiredSessions: 0,
        redactedChatMessages: 0,
        nulledContactPhones: 0,
      })
      .mockResolvedValueOnce({
        config: {
          retentionDays: 90,
          sessionRetentionDays: 30,
          customerContactRetentionDays: 365,
        },
        pendingTaskEvidence: 0,
        pendingExpiredSessions: 0,
        pendingChatMessages: 0,
        pendingContactPhones: 0,
      })
    const { useSettingsPrivacy } = await import('./useSettingsPrivacy')
    const privacy = useSettingsPrivacy(() => true)
    await privacy.runRetentionNow()
    expect(confirm).toHaveBeenCalled()
    expect(api).toHaveBeenCalledWith(
      '/api/system/run-retention',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(privacy.retentionMessage.value).toContain('settings.retentionRunDone')
    confirm.mockRestore()
  })
})
