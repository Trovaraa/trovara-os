import { computed, ref } from 'vue'
import { api } from '@/lib/api'

export type DayCloseData = {
  scope?: 'farm' | 'sales'
  date: string
  generatedAt: string
  tasks?: {
    total: number
    completed: number
    overdue: number
    pendingApproval: number
    rejected: number
    inProgress: number
  }
  pendingApprovals?: {
    id: string
    title: string
    worker: string | null
    plot: string | null
    submittedAt: string
  }[]
  overdueTasks?: {
    id: string
    title: string
    status: string
    dueDate: string | null
    worker: string | null
    plot: string | null
  }[]
  inventory?: {
    lowStockCount: number
    lowStockItems: { id: string; name: string; quantity: number; reorderLevel: number; unit: string }[]
    movementsToday?: number
  }
  livestock?: {
    mortalityToday: number
    incidents: { batch: string | null; headCount: number | null; notes: string | null; at: string }[]
  }
  finance?: { expensesToday: number; totalExpenses: number; currency: string }
  orders?: {
    totalToday: number
    pending: number
    confirmed: number
    dispatched: number
    delivered: number
    cancelled: number
    revenueToday: number
    currency: string
    unpaidCount: number
    unpaidTotal: number
    items: Array<{
      id: string
      customerName: string
      status: string
      paymentStatus: string
      totalAmount: number
      currency: string
    }>
    unpaid: Array<{
      id: string
      customerName: string
      status: string
      paymentStatus: string
      totalAmount: number
      currency: string
    }>
  }
  tomorrowActions: string[]
  status: 'clear' | 'needs_attention'
}

/** Load/toggle state for Today's day-close report (farm + sales). */
export function useTodayDayClose(getRole: () => string | undefined) {
  const dayClose = ref<DayCloseData | null>(null)
  const dayCloseOpen = ref(false)
  const dayCloseLoading = ref(false)

  const showFarmDayClose = computed(() => {
    const role = getRole()
    return role !== 'field_worker' && role !== 'sales'
  })
  const showSalesDayClose = computed(() => getRole() === 'sales')

  async function openDayClose() {
    if (dayClose.value) {
      dayCloseOpen.value = !dayCloseOpen.value
      return
    }
    dayCloseLoading.value = true
    dayCloseOpen.value = true
    try {
      dayClose.value = await api<DayCloseData>('/api/day-close')
    } finally {
      dayCloseLoading.value = false
    }
  }

  return {
    dayClose,
    dayCloseOpen,
    dayCloseLoading,
    showFarmDayClose,
    showSalesDayClose,
    openDayClose,
  }
}
