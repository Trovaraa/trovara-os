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

describe('useInventoryProcurement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loadProcurement fetches suppliers and POs when allowed', async () => {
    api
      .mockResolvedValueOnce({ suppliers: [{ id: 's1', name: 'Agro', active: true }] })
      .mockResolvedValueOnce({ purchaseOrders: [{ id: 'po1', status: 'draft' }] })
    const { useInventoryProcurement } = await import('./useInventoryProcurement')
    const proc = useInventoryProcurement({
      canApprove: () => true,
      getItems: () => [],
      reloadItems: async () => undefined,
    })
    await proc.loadProcurement()
    expect(api).toHaveBeenCalledWith('/api/suppliers')
    expect(api).toHaveBeenCalledWith('/api/purchase-orders')
    expect(proc.suppliers.value).toHaveLength(1)
    expect(proc.purchaseOrders.value).toHaveLength(1)
  })

  it('loadProcurement no-ops without approve permission', async () => {
    const { useInventoryProcurement } = await import('./useInventoryProcurement')
    const proc = useInventoryProcurement({
      canApprove: () => false,
      getItems: () => [],
      reloadItems: async () => undefined,
    })
    await proc.loadProcurement()
    expect(api).not.toHaveBeenCalled()
  })
})
