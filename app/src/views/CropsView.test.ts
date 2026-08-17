import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.fn()

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => api(...args),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params?.count === undefined ? key : `${key}:${params.count}`,
    te: () => true,
  }),
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ canApprove: true }),
}))

const CYCLE = {
  id: 'cycle-1',
  plotId: 'plot-1',
  cropType: 'plantain',
  stage: 'vegetative',
  plantedAt: '2026-02-01T08:00:00.000Z',
  standCount: 480,
  costCentre: 'CC10',
}

const COST_CENTRES = [
  { code: 'CC10', name: 'Plantain', covers: 'Plantain production' },
  { code: 'CC20', name: 'Coconut', covers: 'Coconut estate' },
]

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
    global: {
      stubs: {
        AppLayout: { template: '<div><slot /></div>' },
        RouterLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
      },
    },
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
      if (path === '/api/finance/cost-centres') return { costCentres: COST_CENTRES }
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
      if (path === '/api/finance/cost-centres') return { costCentres: COST_CENTRES }
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
      if (path === '/api/finance/cost-centres') return { costCentres: COST_CENTRES }
      throw new Error('offline')
    })

    const wrapper = await mountCrops()
    await lifecycleButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('crops.lifecycleFailed')
  })

  it('shows stand count and cost centre on the cycle summary', async () => {
    const wrapper = await mountCrops()

    expect(wrapper.text()).toContain('480')
    expect(wrapper.text()).toContain('CC10')
  })

  it('prefills stand count from the saved block and submits the cost centre', async () => {
    api.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/crops' && options?.method === 'POST') return { cropCycle: CYCLE }
      if (path === '/api/crops') return { cropCycles: [CYCLE] }
      if (path === '/api/zones/plots') {
        return {
          plots: [
            { id: 'plot-1', name: 'Block A', zoneName: 'North', active: true, plantCount: 650 },
          ],
        }
      }
      if (path === '/api/finance/cost-centres') return { costCentres: COST_CENTRES }
      return LIFECYCLE
    })

    const wrapper = await mountCrops()
    await wrapper.findAll('button').find((button) => button.text() === 'crops.addCycle')!.trigger('click')
    await flushPromises()

    const cropType = wrapper.find('input[placeholder="crops.cropTypePlaceholder"]')
    const costCentre = wrapper
      .findAll('select')
      .find((select) => select.text().includes('crops.costCentrePlaceholder'))!
    const stands = wrapper.find('input[placeholder="crops.standsPlaceholder"]')
    expect((stands.element as HTMLInputElement).value).toBe('650')

    await cropType.setValue('plantain')
    await costCentre.setValue('CC10')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const createCall = api.mock.calls.find(
      ([path, options]) => path === '/api/crops' && (options as RequestInit | undefined)?.method === 'POST',
    )
    expect(createCall).toBeDefined()
    expect(JSON.parse((createCall![1] as RequestInit).body as string)).toMatchObject({
      standCount: 650,
      costCentre: 'CC10',
    })
  })
})
