import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'

export type ProductHit = {
  title: string
  url: string | null
  source: 'search' | 'llm'
  priceText?: string
  reason?: string
}

export type Recommendation = {
  id: string
  ruleKey: string
  status: string
  sourceType?: string
  sourceId?: string
  notifyRoles: string[]
  payload: {
    happeningNow: string
    whatNext: string
    products?: ProductHit[]
    reasonCode?: string
  }
  aiSummary: string | null
  firedAt: string
}

export type Subject =
  | {
      kind: 'crop'
      id: string
      label: string
      cropType: string
      plotName?: string
      stage: string
      dayInStage: number
      daysUntilNextHint: number | null
      nextHint: string | null
    }
  | {
      kind: 'livestock'
      id: string
      label: string
      species: string
      dayInCycle: number
      daysUntilNextHint: number | null
      nextHint: string | null
    }

export type InsightKey = 'weather' | 'inputs' | 'vaccination' | 'harvest'

export type InsightTip = {
  id: string
  happeningNow: string
  whatNext: string
  products: ProductHit[]
  reasonCode: string
}

/** Tip-bucket lists + insight overlay state for the Advisory analysis tab. */
export function useAdvisoryAnalysis(opts: { onError: (message: string) => void }) {
  const { t } = useI18n()

  const insightKey = ref<InsightKey | null>(null)
  const insightLoading = ref(false)
  const insightTips = ref<InsightTip[]>([])
  const tipBucket = ref<'open' | 'completed' | null>(null)
  const tipBucketLoading = ref(false)
  const tipBucketRows = ref<Recommendation[]>([])

  const insightList = computed(() => [
    { key: 'weather' as const, label: t('advisory.insightWeather') },
    { key: 'inputs' as const, label: t('advisory.insightInputs') },
    { key: 'vaccination' as const, label: t('advisory.insightVax') },
    { key: 'harvest' as const, label: t('advisory.insightHarvest') },
  ])

  const activeInsight = computed(
    () => insightList.value.find((i) => i.key === insightKey.value) ?? null,
  )

  const insightRecommendations = computed(() => insightTips.value)

  async function openInsight(key: InsightKey) {
    tipBucket.value = null
    insightKey.value = key
    insightLoading.value = true
    insightTips.value = []
    try {
      const res = await api<{ tips: InsightTip[] }>(`/api/advisory/insights/${key}`)
      insightTips.value = res.tips ?? []
    } catch (e) {
      opts.onError(e instanceof Error ? e.message : t('advisory.loadError'))
    } finally {
      insightLoading.value = false
    }
  }

  function closeInsight() {
    insightKey.value = null
    insightTips.value = []
  }

  async function openTipBucket(bucket: 'open' | 'completed') {
    tipBucket.value = bucket
    insightKey.value = null
    tipBucketLoading.value = true
    tipBucketRows.value = []
    try {
      const res = await api<{ recommendations: Recommendation[] }>(
        `/api/advisory/recommendations?bucket=${bucket}`,
      )
      tipBucketRows.value = res.recommendations ?? []
    } catch (e) {
      opts.onError(e instanceof Error ? e.message : t('advisory.loadError'))
    } finally {
      tipBucketLoading.value = false
    }
  }

  function closeTipBucket() {
    tipBucket.value = null
    tipBucketRows.value = []
  }

  function clearOverlays() {
    insightKey.value = null
    tipBucket.value = null
  }

  return {
    insightKey,
    insightLoading,
    insightTips,
    tipBucket,
    tipBucketLoading,
    tipBucketRows,
    insightList,
    activeInsight,
    insightRecommendations,
    openInsight,
    closeInsight,
    openTipBucket,
    closeTipBucket,
    clearOverlays,
  }
}
