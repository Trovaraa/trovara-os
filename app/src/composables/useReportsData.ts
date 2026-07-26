import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'

export type OwnerReports = {
  generatedAt: string
  reports: {
    dailyOps: {
      totalTasks: number
      byStatus: Record<string, number>
      overdue: number
      completedToday: number
      awaitingApproval: number
      inProgress: number
    }
    tasksOverdue: {
      count: number
      tasks: {
        id: string
        title: string
        status: string
        dueDate?: string
        plotName?: string
        assignedToName?: string
      }[]
    }
    inventory: {
      totalItems: number
      lowStockCount: number
      items: {
        name: string
        category: string
        quantity: number
        unit: string
        reorderLevel: number
        lowStock: boolean
      }[]
      recentMovements: {
        itemName: string
        unit: string
        delta: number
        reason: string
        createdAt: string
      }[]
    }
    cropStatus: {
      phase: string
      plots: { name: string; cropType: string; areaAcres?: string }[]
      cycles: {
        id: string
        plotName: string
        cropType: string
        stage: string
        plantedAt: string
        expectedHarvestAt?: string
      }[]
    }
    livestock: {
      phase: string
      batchCount: number
      totalHeadCount: number
      batches: {
        id: string
        name: string
        species: string
        headCount: number
        active: boolean
        acquiredAt: string
      }[]
      recentLogs: {
        id: string
        batchName: string
        logType: string
        headCount?: number
        notes?: string
        createdAt: string
      }[]
    }
    sales: {
      phase: string
      totalOrders: number
      byStatus: Record<string, number>
      totalRevenue: number
      currency: string
      recentOrders: {
        id: string
        customerName: string
        status: string
        totalAmount: number
        currency: string
        createdAt: string
      }[]
    }
    pnl: {
      phase: string
      currency: string
      revenue: number
      expenses: number
      net: number
      expensesByCategory: Record<string, number>
    }
    incidents: {
      phase: string
      count: number
      items: {
        id: string
        batchName: string
        headCount?: number
        notes?: string
        createdAt: string
      }[]
    }
    auditTrail: {
      action: string
      entityType: string
      entityId?: string
      userName?: string
      metadata?: unknown
      createdAt: string
    }[]
  }
}

export type DigestReport = {
  generatedAt: string
  report: string
  summary: {
    overdueTasks: number
    lowStock: number
    pendingApprovals: number
    mortalityToday: number
    ordersPending: number
    rejectedTasks: number
    assetLogsMissing: number
    assetVerificationPending: number
    total: number
  }
  sections: Record<string, { count: number; items: unknown[] }>
}

export type BurnRateReport = {
  generatedAt: string
  report: string
  periodDays: number
  items: {
    itemId: string
    name: string
    unit: string
    quantity: number
    reorderLevel: number
    avgDailyConsumption: number
    daysRemaining: number | null
    lowStock: boolean
    needsReorder: boolean
  }[]
}

export type ActionListReport = {
  generatedAt: string
  report: string
  summary: DigestReport['summary']
  actions: {
    priority: number
    action: string
    label: string
    labelKey?: string
    labelParams?: Record<string, string | number>
    titleKey?: string
    titleParams?: Record<string, string | number>
    entityType: string
    entityId: string
    link: string
  }[]
}

export type PlotProfitabilityReport = {
  generatedAt: string
  report: string
  currency: string
  labourRatePerTask: number
  plots: {
    plotId: string
    plotName: string
    cropType: string
    areaAcres: number | null
    tasksCompleted: number
    labourCost: number
    inputCost: number
    revenue: number
    netProfit: number
  }[]
  totals: {
    revenue: number
    labourCost: number
    inputCost: number
    netProfit: number
  }
}

/** Owner reports fetch + shared formatters for ReportsView. */
export function useReportsData() {
  const { t } = useI18n()

  const data = ref<OwnerReports | null>(null)
  const digest = ref<DigestReport | null>(null)
  const burnRate = ref<BurnRateReport | null>(null)
  const actionList = ref<ActionListReport | null>(null)
  const plotProfitability = ref<PlotProfitabilityReport | null>(null)
  const loading = ref(true)
  const error = ref<string | null>(null)

  onMounted(async () => {
    try {
      const [owner, digestRes, burnRateRes, actionListRes, plotPnlRes] = await Promise.all([
        api<OwnerReports>('/api/reports/owner'),
        api<DigestReport>('/api/reports/digest'),
        api<BurnRateReport>('/api/reports/burn-rate'),
        api<ActionListReport>('/api/reports/action-list'),
        api<PlotProfitabilityReport>('/api/reports/plot-profitability'),
      ])
      data.value = owner
      digest.value = digestRes
      burnRate.value = burnRateRes
      actionList.value = actionListRes
      plotProfitability.value = plotPnlRes
    } catch (e) {
      error.value = e instanceof Error ? e.message : t('reports.loadFailed')
    } finally {
      loading.value = false
    }
  })

  function formatMoney(amount: number, currency: string) {
    return new Intl.NumberFormat('en-NG', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleString()
  }

  return {
    data,
    digest,
    burnRate,
    actionList,
    plotProfitability,
    loading,
    error,
    formatMoney,
    formatDate,
  }
}
