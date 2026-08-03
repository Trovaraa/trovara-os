import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'

export type RegistrationTokenRow = {
  id: string
  label: string | null
  createdAt: string
  expiresAt: string
  usedAt: string | null
  usedByEmail: string | null
  revokedAt: string | null
  status: 'valid' | 'used' | 'expired' | 'revoked' | 'not_found'
}

/** Owner registration invite tokens (list / create / revoke). */
export function useSettingsRegistrationTokens(isOwner: () => boolean) {
  const { t } = useI18n()

  const tokens = ref<RegistrationTokenRow[]>([])
  const loading = ref(false)
  const creating = ref(false)
  const revokingId = ref<string | null>(null)
  const message = ref<string | null>(null)
  const createdPlaintext = ref<string | null>(null)
  const label = ref('')
  const ttlHours = ref(24)

  async function loadTokens() {
    if (!isOwner()) return
    loading.value = true
    message.value = null
    try {
      const data = await api<{ tokens: RegistrationTokenRow[] }>('/auth/registration-tokens')
      tokens.value = data.tokens
    } catch (e) {
      message.value = e instanceof Error ? e.message : t('settings.regTokensLoadFailed')
      tokens.value = []
    } finally {
      loading.value = false
    }
  }

  async function createToken() {
    if (!isOwner()) return
    creating.value = true
    message.value = null
    createdPlaintext.value = null
    try {
      const body: { label?: string; ttlHours?: number } = {}
      const trimmed = label.value.trim()
      if (trimmed) body.label = trimmed
      const ttl = Number(ttlHours.value)
      if (Number.isFinite(ttl) && ttl >= 1) body.ttlHours = Math.min(Math.floor(ttl), 24 * 30)

      const created = await api<{ id: string; token: string; expiresAt: string }>(
        '/auth/registration-tokens',
        { method: 'POST', body: JSON.stringify(body) },
      )
      createdPlaintext.value = created.token
      label.value = ''
      message.value = t('settings.regTokenCreated')
      await loadTokens()
    } catch (e) {
      message.value = e instanceof Error ? e.message : t('settings.regTokenCreateFailed')
    } finally {
      creating.value = false
    }
  }

  async function revokeToken(id: string) {
    if (!isOwner()) return
    if (!window.confirm(t('settings.confirmRevokeRegToken'))) return
    revokingId.value = id
    message.value = null
    try {
      await api(`/auth/registration-tokens/${id}/revoke`, { method: 'POST', body: '{}' })
      message.value = t('settings.regTokenRevoked')
      if (createdPlaintext.value) createdPlaintext.value = null
      await loadTokens()
    } catch (e) {
      message.value = e instanceof Error ? e.message : t('settings.regTokenRevokeFailed')
    } finally {
      revokingId.value = null
    }
  }

  async function copyCreatedToken() {
    if (!createdPlaintext.value) return
    try {
      await navigator.clipboard.writeText(createdPlaintext.value)
      message.value = t('settings.regTokenCopied')
    } catch {
      message.value = t('settings.copyFailed')
    }
  }

  return {
    tokens,
    loading,
    creating,
    revokingId,
    message,
    createdPlaintext,
    label,
    ttlHours,
    loadTokens,
    createToken,
    revokeToken,
    copyCreatedToken,
  }
}
