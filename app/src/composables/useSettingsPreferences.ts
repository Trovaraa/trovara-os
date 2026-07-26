import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'

/** Butler TTS + owner alert subscription toggles for Settings. */
export function useSettingsPreferences() {
  const { t } = useI18n()

  const ttsMode = ref<'off' | 'voice_replies' | 'always'>('off')
  const orderAlertsSubscribed = ref(false)
  const workerAlertsSubscribed = ref(false)
  const savingOrderAlerts = ref(false)
  const savingWorkerAlerts = ref(false)
  const orderAlertsMessage = ref<string | null>(null)
  const workerAlertsMessage = ref<string | null>(null)
  const savingTtsMode = ref(false)
  const ttsMessage = ref<string | null>(null)

  async function loadPreferences() {
    try {
      const prefs = await api<{
        butlerTtsMode: 'off' | 'voice_replies' | 'always'
        orderAlertsSubscribed?: boolean
        workerAlertsSubscribed?: boolean
      }>('/auth/preferences')
      ttsMode.value = prefs.butlerTtsMode
      orderAlertsSubscribed.value = Boolean(prefs.orderAlertsSubscribed)
      workerAlertsSubscribed.value = Boolean(prefs.workerAlertsSubscribed)
    } catch {
      ttsMode.value = 'off'
      orderAlertsSubscribed.value = false
      workerAlertsSubscribed.value = false
    }
  }

  async function saveButlerTtsMode() {
    savingTtsMode.value = true
    ttsMessage.value = null
    try {
      await api('/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ butlerTtsMode: ttsMode.value }),
      })
      ttsMessage.value = t('settings.ttsSaved')
    } catch (e) {
      ttsMessage.value = e instanceof Error ? e.message : t('settings.ttsSaveFailed')
    } finally {
      savingTtsMode.value = false
    }
  }

  async function saveOrderAlertsPreference() {
    savingOrderAlerts.value = true
    orderAlertsMessage.value = null
    try {
      const data = await api<{ orderAlertsSubscribed: boolean }>('/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ orderAlertsSubscribed: orderAlertsSubscribed.value }),
      })
      orderAlertsSubscribed.value = Boolean(data.orderAlertsSubscribed)
      orderAlertsMessage.value = t('settings.orderAlertsSaved')
    } catch (e) {
      orderAlertsMessage.value = e instanceof Error ? e.message : t('settings.orderAlertsSaveFailed')
    } finally {
      savingOrderAlerts.value = false
    }
  }

  async function saveWorkerAlertsPreference() {
    savingWorkerAlerts.value = true
    workerAlertsMessage.value = null
    try {
      const data = await api<{ workerAlertsSubscribed: boolean }>('/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify({ workerAlertsSubscribed: workerAlertsSubscribed.value }),
      })
      workerAlertsSubscribed.value = Boolean(data.workerAlertsSubscribed)
      workerAlertsMessage.value = t('settings.workerAlertsSaved')
    } catch (e) {
      workerAlertsMessage.value = e instanceof Error ? e.message : t('settings.workerAlertsSaveFailed')
    } finally {
      savingWorkerAlerts.value = false
    }
  }

  return {
    ttsMode,
    orderAlertsSubscribed,
    workerAlertsSubscribed,
    savingOrderAlerts,
    savingWorkerAlerts,
    orderAlertsMessage,
    workerAlertsMessage,
    savingTtsMode,
    ttsMessage,
    loadPreferences,
    saveButlerTtsMode,
    saveOrderAlertsPreference,
    saveWorkerAlertsPreference,
  }
}
