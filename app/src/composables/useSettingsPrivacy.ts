import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'

type AnonymizeTargets = {
  workers: Array<{ id: string; name: string; email: string }>
  contacts: Array<{ id: string; name: string | null; phone: string | null; channel: string }>
}

type RetentionStatus = {
  config: {
    retentionDays: number
    sessionRetentionDays: number
    customerContactRetentionDays: number
  }
  pendingTaskEvidence: number
  pendingExpiredSessions: number
  pendingChatMessages: number
  pendingContactPhones: number
}

/** Privacy retention + NDPA anonymize controls for Settings (owner-only). */
export function useSettingsPrivacy(isOwner: () => boolean) {
  const { t } = useI18n()

  const retentionStatus = ref<RetentionStatus | null>(null)
  const retentionLoading = ref(false)
  const retentionRunning = ref(false)
  const retentionMessage = ref<string | null>(null)

  const anonymizeTargets = ref<AnonymizeTargets | null>(null)
  const selectedWorkerId = ref('')
  const selectedContactId = ref('')
  const anonymizeReason = ref('')
  const anonymizingWorker = ref(false)
  const anonymizingContact = ref(false)
  const anonymizeMessage = ref<string | null>(null)
  const exportingFarmData = ref(false)
  const farmExportMessage = ref<string | null>(null)
  const exportReason = ref('')

  async function loadPrivacyPanels() {
    if (!isOwner()) return
    try {
      anonymizeTargets.value = await api('/api/privacy/anonymize-targets')
    } catch {
      anonymizeTargets.value = null
    }
    await refreshRetentionStatus()
  }

  async function refreshRetentionStatus() {
    if (!isOwner()) return
    retentionLoading.value = true
    try {
      retentionStatus.value = await api('/api/privacy/retention-status')
    } catch (e) {
      retentionMessage.value = e instanceof Error ? e.message : t('settings.retentionLoadFailed')
    } finally {
      retentionLoading.value = false
    }
  }

  async function runRetentionNow() {
    if (!isOwner()) return
    if (!window.confirm(t('settings.confirmRunRetention'))) return
    retentionRunning.value = true
    retentionMessage.value = null
    try {
      const result = await api<{
        purgedTaskEvidence: number
        purgedExpiredSessions: number
        redactedChatMessages: number
        nulledContactPhones: number
      }>('/api/system/run-retention', { method: 'POST', body: JSON.stringify({}) })
      retentionMessage.value = t('settings.retentionRunDone', {
        evidence: result.purgedTaskEvidence,
        sessions: result.purgedExpiredSessions,
        chat: result.redactedChatMessages,
        phones: result.nulledContactPhones,
      })
      await refreshRetentionStatus()
    } catch (e) {
      retentionMessage.value = e instanceof Error ? e.message : t('settings.retentionRunFailed')
    } finally {
      retentionRunning.value = false
    }
  }

  async function anonymizeSelectedWorker() {
    if (!selectedWorkerId.value) return
    if (!window.confirm(t('settings.confirmAnonymizeWorker'))) return
    anonymizingWorker.value = true
    anonymizeMessage.value = null
    try {
      await api(`/api/privacy/anonymize-user/${selectedWorkerId.value}`, { method: 'POST' })
      anonymizeMessage.value = t('settings.workerAnonymized')
      selectedWorkerId.value = ''
      anonymizeTargets.value = await api('/api/privacy/anonymize-targets')
    } catch (e) {
      anonymizeMessage.value = e instanceof Error ? e.message : t('settings.anonymizeFailed')
    } finally {
      anonymizingWorker.value = false
    }
  }

  async function anonymizeSelectedContact() {
    if (!selectedContactId.value) return
    if (!window.confirm(t('settings.confirmAnonymizeContact'))) return
    anonymizingContact.value = true
    anonymizeMessage.value = null
    try {
      const body = anonymizeReason.value.trim()
        ? JSON.stringify({ reason: anonymizeReason.value.trim() })
        : '{}'
      await api(`/api/privacy/anonymize-contact/${selectedContactId.value}`, {
        method: 'POST',
        body,
      })
      anonymizeMessage.value = t('settings.contactAnonymized')
      selectedContactId.value = ''
      anonymizeTargets.value = await api('/api/privacy/anonymize-targets')
    } catch (e) {
      anonymizeMessage.value = e instanceof Error ? e.message : t('settings.anonymizeFailed')
    } finally {
      anonymizingContact.value = false
    }
  }

  async function exportFarmData() {
    exportingFarmData.value = true
    farmExportMessage.value = null
    try {
      const params = new URLSearchParams()
      const reason = exportReason.value.trim()
      if (reason) params.set('reason', reason)
      const query = params.toString()
      const res = await fetch(`/api/privacy/export${query ? `?${query}` : ''}`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error(t('settings.exportFailed', { status: res.status }))
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `privacy-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      farmExportMessage.value = t('settings.farmExportDownloaded')
    } catch (e) {
      farmExportMessage.value = e instanceof Error ? e.message : t('settings.exportFarmFailed')
    } finally {
      exportingFarmData.value = false
    }
  }

  return {
    retentionStatus,
    retentionLoading,
    retentionRunning,
    retentionMessage,
    anonymizeTargets,
    selectedWorkerId,
    selectedContactId,
    anonymizeReason,
    anonymizingWorker,
    anonymizingContact,
    anonymizeMessage,
    exportingFarmData,
    farmExportMessage,
    exportReason,
    loadPrivacyPanels,
    refreshRetentionStatus,
    runRetentionNow,
    anonymizeSelectedWorker,
    anonymizeSelectedContact,
    exportFarmData,
  }
}
