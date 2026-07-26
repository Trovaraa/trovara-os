import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'

/** Owner admin actions: reset demo, generate tasks, revoke sessions. */
export function useSettingsAdmin(
  isOwner: () => boolean,
  logout: () => Promise<void>,
  reload: () => Promise<void>,
) {
  const { t } = useI18n()

  const resetting = ref(false)
  const resetMessage = ref<string | null>(null)
  const showResetConfirm = ref(false)
  const resetConfirmText = ref('')
  const RESET_CONFIRM_PHRASE = 'I agree'
  const resetConfirmValid = computed(
    () => resetConfirmText.value.trim().toLowerCase() === RESET_CONFIRM_PHRASE.toLowerCase(),
  )
  const generating = ref(false)
  const generateMessage = ref<string | null>(null)
  const revokingSessions = ref(false)
  const revokeMessage = ref<string | null>(null)

  function openResetConfirm() {
    resetConfirmText.value = ''
    resetMessage.value = null
    showResetConfirm.value = true
  }

  function cancelResetConfirm() {
    showResetConfirm.value = false
    resetConfirmText.value = ''
  }

  async function resetDemo() {
    if (!isOwner() || !resetConfirmValid.value) return
    showResetConfirm.value = false
    resetting.value = true
    resetMessage.value = null
    try {
      const data = await api<{ message?: string; requiresReLogin?: boolean }>(
        '/api/onboarding/reset-demo',
        { method: 'POST' },
      )
      if (data.requiresReLogin) {
        sessionStorage.setItem('trovara_flash', data.message ?? t('settings.demoResetSignIn'))
        await logout()
        return
      }
      resetMessage.value = data.message ?? t('settings.demoResetOk')
      await reload()
    } catch (e) {
      resetMessage.value = e instanceof Error ? e.message : t('settings.resetFailed')
    } finally {
      resetting.value = false
      resetConfirmText.value = ''
    }
  }

  async function generateTasks() {
    generating.value = true
    generateMessage.value = null
    try {
      const data = await api<{ count: number }>('/api/templates/generate-tasks', { method: 'POST' })
      generateMessage.value = t('settings.generatedTasks', { count: data.count })
    } catch (e) {
      generateMessage.value = e instanceof Error ? e.message : t('settings.generateFailed')
    } finally {
      generating.value = false
    }
  }

  async function revokeAllOtherSessions() {
    if (!window.confirm(t('settings.confirmRevokeSessions'))) {
      return
    }
    revokingSessions.value = true
    revokeMessage.value = null
    try {
      const data = await api<{ message?: string }>('/auth/revoke-all-sessions', {
        method: 'POST',
      })
      revokeMessage.value = data.message ?? t('settings.sessionsRevoked')
    } catch (e) {
      revokeMessage.value = e instanceof Error ? e.message : t('settings.revokeSessionsFailed')
    } finally {
      revokingSessions.value = false
    }
  }

  return {
    resetting,
    resetMessage,
    showResetConfirm,
    resetConfirmText,
    RESET_CONFIRM_PHRASE,
    resetConfirmValid,
    generating,
    generateMessage,
    revokingSessions,
    revokeMessage,
    openResetConfirm,
    cancelResetConfirm,
    resetDemo,
    generateTasks,
    revokeAllOtherSessions,
  }
}
