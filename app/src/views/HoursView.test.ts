import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()
let currentRole = 'owner'

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => api(...args),
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ user: { role: currentRole } }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, number>) => {
      if (key === 'hours.duration') return `${params?.hours}h ${params?.minutes}m`
      if (key === 'hours.sessions') return `${params?.count} sessions`
      return key
    },
  }),
}))

const SUMMARY = {
  range: 'week',
  people: [
    {
      userId: 'user-1',
      userName: 'Ada',
      role: 'field_worker',
      totalMinutes: 510,
      sessionCount: 2,
      sessions: [
        {
          id: 'session-1',
          clockInAt: '2026-08-10T07:00:00.000Z',
          clockOutAt: '2026-08-10T15:00:00.000Z',
          payableMinutes: 480,
          plotName: 'North field',
          taskTitle: 'Weeding',
          notes: 'Started at row one',
          workSummary: 'Completed four rows',
        },
        {
          id: 'session-2',
          clockInAt: '2026-08-09T08:00:00.000Z',
          clockOutAt: '2026-08-09T08:30:00.000Z',
          payableMinutes: 30,
          plotName: null,
          taskTitle: null,
          notes: null,
          workSummary: null,
        },
      ],
    },
    {
      userId: 'user-2',
      userName: 'Bola',
      role: 'sales',
      totalMinutes: 240,
      sessionCount: 1,
      sessions: [],
    },
  ],
}

async function mountHours(role = 'owner') {
  currentRole = role
  const HoursView = (await import('./HoursView.vue')).default
  const wrapper = mount(HoursView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  api.mockResolvedValue(SUMMARY)
})

describe('HoursView role matrix', () => {
  it.each(['owner', 'supervisor', 'sales', 'field_worker'])(
    'loads the hours summary for %s',
    async (role) => {
      const wrapper = await mountHours(role)

      expect(api).toHaveBeenCalledWith('/api/attendance/summary?range=week')
      expect(wrapper.text()).toContain('hours.title')
      expect(wrapper.text().includes('hours.selfOnlyNote')).toBe(
        role === 'sales' || role === 'field_worker',
      )
    },
  )
})

describe('HoursView summary behavior', () => {
  it('shows the people and time aggregates and expands session detail', async () => {
    const wrapper = await mountHours()

    expect(wrapper.text()).toContain('12h 30m')
    expect(wrapper.text()).toContain('Ada')
    expect(wrapper.text()).toContain('Bola')

    await wrapper.findAll('button').find((button) => button.text().includes('Ada'))!.trigger('click')

    expect(wrapper.text()).toContain('North field')
    expect(wrapper.text()).toContain('Weeding')
    expect(wrapper.text()).toContain('Started at row one')
    expect(wrapper.text()).toContain('Completed four rows')
  })

  it('reloads with the selected range', async () => {
    const wrapper = await mountHours()
    const month = wrapper
      .findAll('button')
      .find((button) => button.text() === 'hours.range.month')!

    await month.trigger('click')
    await flushPromises()

    expect(api).toHaveBeenLastCalledWith('/api/attendance/summary?range=month')
  })
})
