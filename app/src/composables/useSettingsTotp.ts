import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'

/** Authenticator (TOTP) setup / enable / disable for Settings. */
export function useSettingsTotp(reload?: () => Promise<void>) {
  const { t } = useI18n()

  const totpStatus = ref<{ enabled: boolean; hasSecret: boolean } | null>(null)
  const totpSetup = ref<{ secret: string; otpAuthUrl: string; qrUrl: string } | null>(null)
  const totpCode = ref('')
  const totpDisablePassword = ref('')
  const totpLoading = ref(false)
  const totpMessage = ref<string | null>(null)

  async function loadTotp() {
    try {
      totpStatus.value = await api<{ enabled: boolean; hasSecret: boolean }>('/auth/totp/status')
    } catch {
      totpStatus.value = null
    }
  }

  async function setupTotp() {
    totpLoading.value = true
    totpMessage.value = null
    try {
      totpSetup.value = await api<{ secret: string; otpAuthUrl: string; qrUrl: string }>(
        '/auth/totp/setup',
        { method: 'POST' },
      )
      await reload?.()
    } catch (e) {
      totpMessage.value = e instanceof Error ? e.message : t('settings.totpSetupFailed')
    } finally {
      totpLoading.value = false
    }
  }

  async function enableTotp() {
    if (!/^\d{6}$/.test(totpCode.value.trim())) return
    totpLoading.value = true
    totpMessage.value = null
    try {
      await api('/auth/totp/enable', {
        method: 'POST',
        body: JSON.stringify({ token: totpCode.value.trim() }),
      })
      totpCode.value = ''
      totpSetup.value = null
      totpMessage.value = t('settings.twoFaEnabledMsg')
      await reload?.()
    } catch (e) {
      totpMessage.value = e instanceof Error ? e.message : t('settings.enable2faFailed')
    } finally {
      totpLoading.value = false
    }
  }

  async function disableTotp() {
    if (!/^\d{6}$/.test(totpCode.value.trim())) return
    if (!totpDisablePassword.value.trim()) {
      totpMessage.value = t('settings.enterPasswordDisable')
      return
    }
    if (!window.confirm(t('settings.confirmDisable2fa'))) return
    totpLoading.value = true
    totpMessage.value = null
    try {
      await api('/auth/totp/disable', {
        method: 'POST',
        body: JSON.stringify({
          token: totpCode.value.trim(),
          password: totpDisablePassword.value,
        }),
      })
      totpCode.value = ''
      totpDisablePassword.value = ''
      totpSetup.value = null
      totpMessage.value = t('settings.twoFaDisabledMsg')
      await reload?.()
    } catch (e) {
      totpMessage.value = e instanceof Error ? e.message : t('settings.disable2faFailed')
    } finally {
      totpLoading.value = false
    }
  }

  return {
    totpStatus,
    totpSetup,
    totpCode,
    totpDisablePassword,
    totpLoading,
    totpMessage,
    loadTotp,
    setupTotp,
    enableTotp,
    disableTotp,
  }
}
