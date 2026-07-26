import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => api(...args),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    te: () => true,
  }),
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ canApprove: false }),
}))

const CYCLE = {
  id: 'cycle-1',
  plotId: 'plot-1',
  cropType: 'plantain',
  stage: 'vegetative',
  plantedAt: '2026-02-01T08:00:00.000Z',
}

const LIFECYCLE = {
  generated: true,
  agronomySkipReason: null,
  expectedHarvestAt: '2026-06-06T08:00:00.000Z',
  totalDays: 155,
  stages: [
    {
      id: 'stage-1',
      stage: 'vegetative',
      durationDays: 90,
      source: 'generated',
      startsOn: '2026-03-08T08:00:00.000Z',
      endsOn: '2026-06-06T08:00:00.000Z',
    },
  ],
  tasks: [
    {
      id: 'task-1',
      stage: 'vegetative',
      offsetDays: 30,
      templateName: 'Ring weed each stool',
      description: 'Clear a metre around every stool.',
      defaultDurationHours: 4,
      source: 'generated',
      dueDate: '2026-04-07T08:00:00.000Z',
    },
  ],
}

async function mountCrops() {
  const CropsView = (await import('./CropsView.vue')).default
  const wrapper = mount(CropsView, {
    global: { stubs: { AppLayout: { template: '<div><slot /></div>' } } },
  })
  await flushPromises()
  return wrapper
}

function lifecycleButton(wrapper: Awaited<ReturnType<typeof mountCrops>>) {
  return wrapper
    .findAll('button')
    .find((button) => ['crops.lifecycle', 'crops.hideLifecycle'].includes(button.text()))!
}

describe('CropsView lifecycle panel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.mockImplementation(async (path: string) => {
      if (path === '/api/crops') return { cropCycles: [CYCLE] }
      if (path === '/api/zones/plots') return { plots: [] }
      return LIFECYCLE
    })
  })

  it('shows the cycle own stages and work once it is opened', async () => {
    const wrapper = await mountCrops()
    expect(api).not.toHaveBeenCalledWith('/api/crops/cycle-1/lifecycle')

    await lifecycleButton(wrapper).trigger('click')
    await flushPromises()

    expect(api).toHaveBeenCalledWith('/api/crops/cycle-1/lifecycle')
    // The work per stage is what only this endpoint carries; the lifecycles list
    // on the templates screen has stage durations and nothing else.
    expect(wrapper.text()).toContain('Ring weed each stool')
    expect(wrapper.text()).toContain('crops.harvestOpens')
  })

  it('reads the lifecycle once across open and close', async () => {
    const wrapper = await mountCrops()

    await lifecycleButton(wrapper).trigger('click')
    await flushPromises()
    await lifecycleButton(wrapper).trigger('click')
    await lifecycleButton(wrapper).trigger('click')
    await flushPromises()

    expect(api.mock.calls.filter(([path]) => path === '/api/crops/cycle-1/lifecycle')).toHaveLength(
      1,
    )
  })

  it('explains an empty lifecycle instead of showing an empty panel', async () => {
    api.mockImplementation(async (path: string) => {
      if (path === '/api/crops') return { cropCycles: [CYCLE] }
      if (path === '/api/zones/plots') return { plots: [] }
      return {
        generated: false,
        agronomySkipReason: 'budget_exhausted',
        expectedHarvestAt: null,
        totalDays: null,
        stages: [],
        tasks: [],
      }
    })

    const wrapper = await mountCrops()
    await lifecycleButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('crops.noLifecycle')
    expect(wrapper.text()).toContain('agronomy.skipBudget')
    expect(wrapper.text()).not.toContain('crops.lifecycleStages')
  })

  it('says so when the lifecycle cannot be read', async () => {
    api.mockImplementation(async (path: string) => {
      if (path === '/api/crops') return { cropCycles: [CYCLE] }
      if (path === '/api/zones/plots') return { plots: [] }
      throw new Error('offline')
    })

    const wrapper = await mountCrops()
    await lifecycleButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('crops.lifecycleFailed')
  })
})
