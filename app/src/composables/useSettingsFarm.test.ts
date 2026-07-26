import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => api(...args),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

describe('useSettingsFarm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loadFarm no-ops for non-owners', async () => {
    const { useSettingsFarm } = await import('./useSettingsFarm')
    const farm = useSettingsFarm(() => false)
    await farm.loadFarm()
    expect(api).not.toHaveBeenCalled()
  })

  it('loadFarm hydrates form fields', async () => {
    api.mockResolvedValueOnce({
      farm: {
        id: 'f1',
        name: 'Demo Farm',
        location: 'Lagos',
        latitude: '6.5',
        longitude: '3.3',
        timezone: 'Africa/Lagos',
      },
    })
    const { useSettingsFarm } = await import('./useSettingsFarm')
    const farm = useSettingsFarm(() => true)
    await farm.loadFarm()
    expect(farm.farmName.value).toBe('Demo Farm')
    expect(farm.farmLatitude.value).toBe('6.5')
  })

  it('saveFarmLocation PATCHes /api/farm', async () => {
    api.mockResolvedValueOnce({
      farm: {
        id: 'f1',
        name: 'North Farm',
        location: 'Ibadan',
        latitude: null,
        longitude: null,
        timezone: 'Africa/Lagos',
      },
    })
    const { useSettingsFarm } = await import('./useSettingsFarm')
    const farm = useSettingsFarm(() => true)
    farm.farmName.value = 'North Farm'
    farm.farmLocation.value = 'Ibadan'
    await farm.saveFarmLocation()
    expect(api).toHaveBeenCalledWith(
      '/api/farm',
      expect.objectContaining({ method: 'PATCH' }),
    )
    expect(farm.farmMessage.value).toBe('settings.farmSaved')
  })
})
