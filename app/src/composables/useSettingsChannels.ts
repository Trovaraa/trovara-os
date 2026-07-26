import { onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'

/** WhatsApp phone + Telegram butler link code for Settings. */
export function useSettingsChannels() {
  const { t } = useI18n()

  const generatingLinkCode = ref(false)
  const linkCode = ref<string | null>(null)
  const linkCodeExpiresAt = ref<string | null>(null)
  const linkCodeRemaining = ref('')
  const linkCodeMessage = ref<string | null>(null)
  const telegramLinked = ref(false)
  const revokingTelegram = ref(false)
  const telegramMessage = ref<string | null>(null)
  const myPhone = ref('')
  const savingPhone = ref(false)
  const phoneMessage = ref<string | null>(null)
  let linkCodeTimer: ReturnType<typeof setInterval> | null = null

  function updateLinkCodeCountdown() {
    if (!linkCodeExpiresAt.value) {
      linkCodeRemaining.value = ''
      return
    }
    const ms = new Date(linkCodeExpiresAt.value).getTime() - Date.now()
    if (ms <= 0) {
      linkCodeRemaining.value = t('settings.expired')
      linkCode.value = null
      if (linkCodeTimer) {
        clearInterval(linkCodeTimer)
        linkCodeTimer = null
      }
      return
    }
    const totalSec = Math.ceil(ms / 1000)
    const min = Math.floor(totalSec / 60)
    const sec = totalSec % 60
    linkCodeRemaining.value = `${min}:${String(sec).padStart(2, '0')}`
  }

  async function loadChannels() {
    try {
      const links = await api<{ telegramLinked: boolean; phone?: string | null }>(
        '/api/users/me/channel-links',
      )
      telegramLinked.value = links.telegramLinked
      myPhone.value = links.phone ?? ''
    } catch {
      telegramLinked.value = false
      myPhone.value = ''
    }
  }

  async function generateButlerLinkCode() {
    generatingLinkCode.value = true
    linkCodeMessage.value = null
    try {
      const data = await api<{ code: string; expiresAt: string }>('/api/users/me/butler-link-code', {
        method: 'POST',
      })
      linkCode.value = data.code
      linkCodeExpiresAt.value = data.expiresAt
      updateLinkCodeCountdown()
      if (linkCodeTimer) clearInterval(linkCodeTimer)
      linkCodeTimer = setInterval(updateLinkCodeCountdown, 1000)
    } catch (e) {
      linkCodeMessage.value = e instanceof Error ? e.message : t('settings.generateLinkFailed')
    } finally {
      generatingLinkCode.value = false
    }
  }

  async function copyLinkCode() {
    if (!linkCode.value) return
    try {
      await navigator.clipboard.writeText(linkCode.value)
      linkCodeMessage.value = t('settings.codeCopied')
    } catch {
      linkCodeMessage.value = t('settings.copyFailed')
    }
  }

  async function revokeTelegramLink() {
    if (!window.confirm(t('settings.confirmRevokeTelegram'))) {
      return
    }
    revokingTelegram.value = true
    telegramMessage.value = null
    try {
      await api('/api/users/me/telegram-link', { method: 'DELETE' })
      telegramLinked.value = false
      telegramMessage.value = t('settings.telegramRevoked')
    } catch (e) {
      telegramMessage.value = e instanceof Error ? e.message : t('settings.revokeTelegramFailed')
    } finally {
      revokingTelegram.value = false
    }
  }

  async function saveMyPhone() {
    savingPhone.value = true
    phoneMessage.value = null
    try {
      await api('/api/users/me', {
        method: 'PATCH',
        body: JSON.stringify({ phone: myPhone.value.trim() || null }),
      })
      phoneMessage.value = t('settings.phoneSaved')
    } catch (e) {
      phoneMessage.value = e instanceof Error ? e.message : t('settings.phoneSaveFailed')
    } finally {
      savingPhone.value = false
    }
  }

  onUnmounted(() => {
    if (linkCodeTimer) clearInterval(linkCodeTimer)
  })

  return {
    generatingLinkCode,
    linkCode,
    linkCodeRemaining,
    linkCodeMessage,
    telegramLinked,
    revokingTelegram,
    telegramMessage,
    myPhone,
    savingPhone,
    phoneMessage,
    loadChannels,
    generateButlerLinkCode,
    copyLinkCode,
    revokeTelegramLink,
    saveMyPhone,
  }
}
