import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'

export type ProcurementItem = {
  id: string
  name: string
  unit: string
}

export type Supplier = {
  id: string
  name: string
  phone?: string | null
  email?: string | null
  active: boolean
}

export type PurchaseOrderLine = {
  id: string
  itemId?: string | null
  itemName: string
  unit: string
  quantityOrdered: number
  quantityReceived: number
  unitCostMinor?: number | null
}

export type PurchaseOrder = {
  id: string
  supplierId: string
  supplierName: string
  status: string
  expectedAt?: string | null
  createdAt: string
  lines?: PurchaseOrderLine[]
}

export type PoDraftLine = {
  itemId: string
  quantityOrdered: number
  unitCostMinor: number | ''
}

/** Suppliers + purchase orders for Inventory (approve-gated). */
export function useInventoryProcurement(opts: {
  canApprove: () => boolean
  getItems: () => ProcurementItem[]
  reloadItems: () => Promise<void>
}) {
  const { t } = useI18n()

  const suppliers = ref<Supplier[]>([])
  const purchaseOrders = ref<PurchaseOrder[]>([])
  const selectedPurchaseOrder = ref<PurchaseOrder | null>(null)
  const newSupplierName = ref('')
  const supplierSaving = ref(false)
  const poSupplierId = ref('')
  const poExpectedAt = ref('')
  const poNotes = ref('')
  const poLines = ref<PoDraftLine[]>([{ itemId: '', quantityOrdered: 1, unitCostMinor: '' }])
  const poSaving = ref(false)
  const poActionId = ref<string | null>(null)
  const receiveQuantities = ref<Record<string, number | ''>>({})
  const poMessage = ref<string | null>(null)

  async function loadProcurement() {
    if (!opts.canApprove()) return
    try {
      const [supplierData, orderData] = await Promise.all([
        api<{ suppliers: Supplier[] }>('/api/suppliers'),
        api<{ purchaseOrders: PurchaseOrder[] }>('/api/purchase-orders'),
      ])
      suppliers.value = supplierData.suppliers
      purchaseOrders.value = orderData.purchaseOrders
      if (!poSupplierId.value) poSupplierId.value = suppliers.value.find((s) => s.active)?.id ?? ''
    } catch (e) {
      poMessage.value = e instanceof Error ? e.message : t('inventory.poLoadFailed')
    }
  }

  async function createSupplier() {
    if (!newSupplierName.value.trim()) return
    supplierSaving.value = true
    poMessage.value = null
    try {
      await api('/api/suppliers', {
        method: 'POST',
        body: JSON.stringify({ name: newSupplierName.value.trim() }),
      })
      newSupplierName.value = ''
      await loadProcurement()
    } catch (e) {
      poMessage.value = e instanceof Error ? e.message : t('inventory.supplierSaveFailed')
    } finally {
      supplierSaving.value = false
    }
  }

  function addPoLine() {
    poLines.value.push({ itemId: '', quantityOrdered: 1, unitCostMinor: '' })
  }

  async function createPurchaseOrder() {
    const items = opts.getItems()
    const lines = poLines.value.filter((line) => line.itemId).map((line) => {
      const item = items.find((candidate) => candidate.id === line.itemId)!
      return {
        itemId: item.id,
        itemName: item.name,
        unit: item.unit,
        quantityOrdered: Math.max(1, Math.trunc(Number(line.quantityOrdered))),
        unitCostMinor: line.unitCostMinor === '' ? null : Math.max(0, Math.trunc(Number(line.unitCostMinor))),
      }
    })
    if (!poSupplierId.value || !lines.length) return
    poSaving.value = true
    poMessage.value = null
    try {
      await api('/api/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: poSupplierId.value,
          expectedAt: poExpectedAt.value ? new Date(poExpectedAt.value).toISOString() : null,
          notes: poNotes.value.trim() || null,
          lines,
        }),
      })
      poLines.value = [{ itemId: '', quantityOrdered: 1, unitCostMinor: '' }]
      poExpectedAt.value = ''
      poNotes.value = ''
      poMessage.value = t('inventory.poDraftSaved')
      await loadProcurement()
    } catch (e) {
      poMessage.value = e instanceof Error ? e.message : t('inventory.poSaveFailed')
    } finally {
      poSaving.value = false
    }
  }

  async function openPurchaseOrder(id: string) {
    poActionId.value = id
    try {
      const data = await api<{ purchaseOrder: PurchaseOrder }>(`/api/purchase-orders/${id}`)
      selectedPurchaseOrder.value = data.purchaseOrder
      receiveQuantities.value = Object.fromEntries(
        (data.purchaseOrder.lines ?? []).map((line) => [line.id, '']),
      )
    } finally {
      poActionId.value = null
    }
  }

  async function purchaseOrderAction(id: string, action: 'approve' | 'send' | 'cancel') {
    poActionId.value = id
    poMessage.value = null
    try {
      await api(`/api/purchase-orders/${id}/${action}`, { method: 'POST' })
      await loadProcurement()
      await openPurchaseOrder(id)
    } catch (e) {
      poMessage.value = e instanceof Error ? e.message : t('inventory.poActionFailed')
    } finally {
      poActionId.value = null
    }
  }

  async function receivePurchaseOrder() {
    if (!selectedPurchaseOrder.value?.lines) return
    const lines = selectedPurchaseOrder.value.lines
      .filter((line) => Number(receiveQuantities.value[line.id]) > 0)
      .map((line) => ({
        purchaseOrderLineId: line.id,
        quantityReceived: Math.trunc(Number(receiveQuantities.value[line.id])),
      }))
    if (!lines.length) return
    poActionId.value = selectedPurchaseOrder.value.id
    poMessage.value = null
    try {
      await api(`/api/purchase-orders/${selectedPurchaseOrder.value.id}/receipts`, {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), lines }),
      })
      poMessage.value = t('inventory.receiptPosted')
      await Promise.all([
        opts.reloadItems(),
        loadProcurement(),
        openPurchaseOrder(selectedPurchaseOrder.value.id),
      ])
    } catch (e) {
      poMessage.value = e instanceof Error ? e.message : t('inventory.receiveFailed')
    } finally {
      poActionId.value = null
    }
  }

  return {
    suppliers,
    purchaseOrders,
    selectedPurchaseOrder,
    newSupplierName,
    supplierSaving,
    poSupplierId,
    poExpectedAt,
    poNotes,
    poLines,
    poSaving,
    poActionId,
    receiveQuantities,
    poMessage,
    loadProcurement,
    createSupplier,
    addPoLine,
    createPurchaseOrder,
    openPurchaseOrder,
    purchaseOrderAction,
    receivePurchaseOrder,
  }
}
