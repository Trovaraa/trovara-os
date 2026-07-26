import { computed, ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'

export type Checklist = {
  hasZones: boolean
  hasTemplates: boolean
  hasUsers: boolean
  zonesCount: number
  templatesCount: number
  usersCount: number
}

export type BillingStatus = {
  enabled: boolean
  mode: string
  message: string
  roadmap: Record<string, string>
  docs: string
}

/** Go-live checklist + onboarding status for Settings (owner-only). */
export function useSettingsOnboarding(
  isOwner: () => boolean,
  farmName: Ref<string>,
  farmProfileName: () => string | undefined,
  reload: () => Promise<void>,
) {
  const { t } = useI18n()

  const checklist = ref<Checklist | null>(null)
  const ready = ref(false)
  const liveMode = ref(false)
  const billingStatus = ref<BillingStatus | null>(null)
  const goingLive = ref(false)
  const goLiveMessage = ref<string | null>(null)

  const goLiveItems = computed(() => {
    if (!checklist.value) return []
    const c = checklist.value
    const farmNameLower = (farmProfileName() ?? farmName.value).trim().toLowerCase()
    const demoDataRemoved =
      liveMode.value || (farmNameLower.length > 0 && !farmNameLower.includes('demo'))

    return [
      { label: t('settings.clFounderAccount'), done: true },
      {
        label: t('settings.clUsers', { count: c.usersCount }),
        done: c.hasUsers,
        hint: t('settings.clUsersHint'),
      },
      {
        label: t('settings.clDemo'),
        done: demoDataRemoved,
        hint: t('settings.clDemoHint'),
      },
    ]
  })

  const goLiveDoneCount = computed(() => goLiveItems.value.filter((i) => i.done).length)
  const goLiveReady = computed(
    () => goLiveItems.value.length > 0 && goLiveDoneCount.value === goLiveItems.value.length,
  )

  async function loadOnboarding() {
    if (!isOwner()) return
    try {
      const [statusData, billData] = await Promise.all([
        api<{ checklist: Checklist; ready: boolean; liveMode?: boolean }>('/api/onboarding/status'),
        api<BillingStatus>('/api/billing/status'),
      ])
      checklist.value = statusData.checklist
      ready.value = statusData.ready
      liveMode.value = !!statusData.liveMode
      billingStatus.value = billData
    } catch {
      checklist.value = null
      billingStatus.value = null
    }
  }

  async function goLive() {
    if (!window.confirm(t('settings.confirmGoLive'))) {
      return
    }
    goingLive.value = true
    goLiveMessage.value = null
    try {
      const data = await api<{ farm?: unknown; message?: string }>('/api/onboarding/go-live', {
        method: 'POST',
      })
      goLiveMessage.value = data.message ?? t('settings.liveModeDone')
      liveMode.value = true
      await reload()
    } catch (e) {
      goLiveMessage.value = e instanceof Error ? e.message : t('settings.goLiveFailed')
    } finally {
      goingLive.value = false
    }
  }

  return {
    checklist,
    ready,
    liveMode,
    billingStatus,
    goingLive,
    goLiveMessage,
    goLiveItems,
    goLiveDoneCount,
    goLiveReady,
    loadOnboarding,
    goLive,
  }
}
