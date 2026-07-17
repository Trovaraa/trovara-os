<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()

type Checklist = {
  hasZones: boolean
  hasTemplates: boolean
  hasUsers: boolean
  zonesCount: number
  templatesCount: number
  usersCount: number
}

type IntegrationStatus = {
  configured: boolean
  hint?: string
}

type BillingStatus = {
  enabled: boolean
  mode: string
  message: string
  roadmap: Record<string, string>
  docs: string
}

type SystemStatus = {
  api: string
  db: string
  dbLatencyMs: number
  lastBackup: string | null
  backupCount: number
  whatsappConfigured: boolean
  aiMode: string
  commit: string
  env: string
  ts: string
}

const loading = ref(true)
const auth = useAuthStore()
const checklist = ref<Checklist | null>(null)
const ready = ref(false)
const liveMode = ref(false)
const aiStatus = ref<IntegrationStatus | null>(null)
const whatsappStatus = ref<IntegrationStatus | null>(null)
const billingStatus = ref<BillingStatus | null>(null)
const systemStatus = ref<SystemStatus | null>(null)

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
const goingLive = ref(false)
const goLiveMessage = ref<string | null>(null)
const revokingSessions = ref(false)
const revokeMessage = ref<string | null>(null)
const exportingFarmData = ref(false)
const farmExportMessage = ref<string | null>(null)
const totpStatus = ref<{ enabled: boolean; hasSecret: boolean } | null>(null)
const totpSetup = ref<{ secret: string; otpAuthUrl: string; qrUrl: string } | null>(null)
const totpCode = ref('')
const totpDisablePassword = ref('')
const totpLoading = ref(false)
const totpMessage = ref<string | null>(null)
const ttsMode = ref<'off' | 'voice_replies' | 'always'>('off')
const savingTtsMode = ref(false)
const ttsMessage = ref<string | null>(null)
const generatingLinkCode = ref(false)
const linkCode = ref<string | null>(null)
const linkCodeExpiresAt = ref<string | null>(null)
const linkCodeRemaining = ref('')
const linkCodeMessage = ref<string | null>(null)
const telegramLinked = ref(false)
const revokingTelegram = ref(false)
const telegramMessage = ref<string | null>(null)
let linkCodeTimer: ReturnType<typeof setInterval> | null = null

const goLiveItems = computed(() => {
  if (!checklist.value) return []
  const c = checklist.value
  const items: { label: string; done: boolean; hint?: string }[] = [
    { label: t('settings.clFounderAccount'), done: true },
    {
      label: t('settings.clUsers', { count: c.usersCount }),
      done: c.hasUsers,
      hint: 'Add team members in Users',
    },
    {
      label: t('settings.zonesConfigured', { count: c.zonesCount }),
      done: c.hasZones,
      hint: 'Create zones in Zones',
    },
    {
      label: t('settings.templatesCreated', { count: c.templatesCount }),
      done: c.hasTemplates,
      hint: 'Create templates in Templates',
    },
    {
      label: t('settings.clWhatsapp'),
      done: whatsappStatus.value?.configured ?? false,
      hint: 'Add WA_PHONE_NUMBER_ID + WA_ACCESS_TOKEN to .env',
    },
    {
      label: t('settings.clBackup'),
      done: (systemStatus.value?.backupCount ?? 0) > 0,
      hint: 'Run ./scripts/backup-db.sh then ./scripts/verify-backup.sh',
    },
    {
      label: t('settings.clBookmark'),
      done: false,
      hint: 'Open http://[laptop-ip]:5173 on each phone and add to home screen',
    },
    {
      label: t('settings.clDemo'),
      done: false,
      hint: 'Use Reset demo data below, then enter real farm data',
    },
  ]
  return items
})

const goLiveDoneCount = computed(() => goLiveItems.value.filter((i) => i.done).length)
const goLiveReady = computed(
  () => goLiveItems.value.length > 0 && goLiveDoneCount.value === goLiveItems.value.length,
)

async function load() {
  loading.value = true
  try {
    const [statusData, aiData, waData, billData] = await Promise.all([
      api<{ checklist: Checklist; ready: boolean; liveMode?: boolean }>('/onboarding/status'),
      api<IntegrationStatus>('/api/ai/status'),
      api<IntegrationStatus>('/api/whatsapp/status'),
      api<BillingStatus>('/api/billing/status'),
    ])
    checklist.value = statusData.checklist
    ready.value = statusData.ready
    liveMode.value = !!statusData.liveMode
    aiStatus.value = aiData
    whatsappStatus.value = waData
    billingStatus.value = billData

    try {
      systemStatus.value = await api<SystemStatus>('/system-status')
    } catch {
      // non-critical
    }

    try {
      totpStatus.value = await api<{ enabled: boolean; hasSecret: boolean }>('/auth/totp/status')
    } catch {
      totpStatus.value = null
    }

    try {
      const prefs = await api<{ butlerTtsMode: 'off' | 'voice_replies' | 'always' }>('/auth/preferences')
      ttsMode.value = prefs.butlerTtsMode
    } catch {
      ttsMode.value = 'off'
    }

    try {
      const links = await api<{ telegramLinked: boolean }>('/api/users/me/channel-links')
      telegramLinked.value = links.telegramLinked
    } catch {
      telegramLinked.value = false
    }
  } finally {
    loading.value = false
  }
}

async function goLive() {
  if (!window.confirm(t('settings.confirmGoLive'))) {
    return
  }
  goingLive.value = true
  goLiveMessage.value = null
  try {
    const data = await api<{ message?: string }>('/onboarding/go-live', { method: 'POST' })
    goLiveMessage.value = data.message ?? t('settings.liveModeDone')
    await load()
  } catch (e) {
    goLiveMessage.value = e instanceof Error ? e.message : t('settings.goLiveFailed')
  } finally {
    goingLive.value = false
  }
}

onMounted(load)

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

onUnmounted(() => {
  if (linkCodeTimer) clearInterval(linkCodeTimer)
})

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
  // Founder-only, destructive: require the exact confirmation phrase before wiping data.
  if (!auth.isOwner || !resetConfirmValid.value) return
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
      await auth.logout()
      return
    }
    resetMessage.value = data.message ?? t('settings.demoResetOk')
    await load()
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

async function setupTotp() {
  totpLoading.value = true
  totpMessage.value = null
  try {
    totpSetup.value = await api<{ secret: string; otpAuthUrl: string; qrUrl: string }>('/auth/totp/setup', {
      method: 'POST',
    })
    await load()
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
    await load()
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
    await load()
  } catch (e) {
    totpMessage.value = e instanceof Error ? e.message : t('settings.disable2faFailed')
  } finally {
    totpLoading.value = false
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

async function exportFarmData() {
  exportingFarmData.value = true
  farmExportMessage.value = null
  try {
    const res = await fetch('/api/exports/farm-data.json', {
      credentials: 'include',
    })
    if (!res.ok) throw new Error(t('settings.exportFailed', { status: res.status }))
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `farm-data-export-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    farmExportMessage.value = t('settings.farmExportDownloaded')
  } catch (e) {
    farmExportMessage.value = e instanceof Error ? e.message : t('settings.exportFarmFailed')
  } finally {
    exportingFarmData.value = false
  }
}

function formatBackupTime(iso: string | null): string {
  if (!iso) return t('settings.backupNever')
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-white">{{ t('settings.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1">{{ t('settings.subtitle') }}</p>
      <RouterLink
        to="/settings/security"
        class="inline-flex mt-3 text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-farm-green hover:bg-slate-700"
      >
        {{ t('settings.securityDashboard') }}
      </RouterLink>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('settings.loading') }}</div>

    <template v-else>
      <!-- Go-Live Checklist -->
      <div
        class="mt-8 bg-slate-900 border rounded-xl p-5"
        :class="goLiveReady ? 'border-farm-green/40' : 'border-amber-700/30'"
      >
        <div class="flex items-center justify-between gap-4 mb-4">
          <div>
            <h3 class="font-bold text-white">{{ t('settings.goLiveTitle') }}</h3>
            <p class="text-xs text-slate-400 mt-0.5">{{ t('settings.goLiveSubtitle') }}</p>
          </div>
          <span
            class="text-xs font-bold px-2.5 py-1 rounded-full whitespace-nowrap"
            :class="goLiveReady ? 'bg-farm-green/20 text-farm-green' : 'bg-amber-900/30 text-amber-300'"
          >
            {{ goLiveDoneCount }}/{{ goLiveItems.length }}
            {{ goLiveReady ? `- ${t('settings.ready')}` : `- ${t('settings.notReady')}` }}
          </span>
        </div>
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <span
            class="text-xs font-bold px-2.5 py-1 rounded-full"
            :class="liveMode ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-300'"
          >
            {{ liveMode ? t('settings.liveModeEnabled') : t('settings.demoMode') }}
          </span>
          <button
            v-if="!liveMode"
            type="button"
            class="text-xs font-bold px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
            :disabled="goingLive"
            @click="goLive"
          >
            {{ goingLive ? t('settings.switching') : t('settings.goLiveNow') }}
          </button>
        </div>
        <p v-if="goLiveMessage" class="text-xs text-slate-400 mb-3">{{ goLiveMessage }}</p>
        <ul class="space-y-2.5">
          <li v-for="(item, idx) in goLiveItems" :key="idx" class="flex items-start gap-3 text-sm">
            <span
              class="mt-0.5 shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold"
              :class="item.done ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-500'"
            >
              {{ item.done ? '✓' : '○' }}
            </span>
            <div class="min-w-0">
              <p :class="item.done ? 'text-slate-300' : 'text-white'">{{ item.label }}</p>
              <p v-if="!item.done && item.hint" class="text-xs text-slate-500 mt-0.5">{{ item.hint }}</p>
            </div>
          </li>
        </ul>
      </div>

      <!-- Onboarding checklist -->
      <div class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
        <div class="flex items-center justify-between gap-4">
          <h3 class="font-bold text-white">{{ t('settings.onboardingTitle') }}</h3>
          <span
            class="text-xs font-bold px-2.5 py-1 rounded-full"
            :class="ready ? 'bg-farm-green/20 text-farm-green' : 'bg-amber-900/40 text-amber-300'"
          >
            {{ ready ? t('settings.ready') : t('settings.incomplete') }}
          </span>
        </div>
        <ul v-if="checklist" class="mt-4 space-y-3">
          <li class="flex items-center gap-3 text-sm">
            <span :class="checklist.hasZones ? 'text-farm-green' : 'text-slate-500'">
              {{ checklist.hasZones ? '✓' : '○' }}
            </span>
            <span class="text-slate-300">{{ t('settings.zonesConfigured', { count: checklist.zonesCount }) }}</span>
          </li>
          <li class="flex items-center gap-3 text-sm">
            <span :class="checklist.hasTemplates ? 'text-farm-green' : 'text-slate-500'">
              {{ checklist.hasTemplates ? '✓' : '○' }}
            </span>
            <span class="text-slate-300">{{ t('settings.templatesCreated', { count: checklist.templatesCount }) }}</span>
          </li>
          <li class="flex items-center gap-3 text-sm">
            <span :class="checklist.hasUsers ? 'text-farm-green' : 'text-slate-500'">
              {{ checklist.hasUsers ? '✓' : '○' }}
            </span>
            <span class="text-slate-300">{{ t('settings.teamAdded', { count: checklist.usersCount }) }}</span>
          </li>
        </ul>
      </div>

      <!-- System Status -->
      <div v-if="systemStatus" class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h3 class="font-bold text-white text-sm mb-4">{{ t('settings.systemStatus') }}</h3>
        <div class="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p class="text-xs text-slate-500">{{ t('settings.api') }}</p>
            <p class="font-medium" :class="systemStatus.api === 'ok' ? 'text-farm-green' : 'text-red-400'">
              {{ systemStatus.api === 'ok' ? t('settings.statusOk') : t('settings.statusError') }}
            </p>
          </div>
          <div>
            <p class="text-xs text-slate-500">{{ t('settings.database') }}</p>
            <p class="font-medium" :class="systemStatus.db === 'ok' ? 'text-farm-green' : 'text-red-400'">
              {{ systemStatus.db === 'ok' ? t('settings.statusOkLatency', { ms: systemStatus.dbLatencyMs }) : t('settings.statusError') }}
            </p>
          </div>
          <div>
            <p class="text-xs text-slate-500">{{ t('settings.lastBackup') }}</p>
            <p class="font-medium text-slate-300 text-xs">{{ formatBackupTime(systemStatus.lastBackup) }}</p>
          </div>
          <div>
            <p class="text-xs text-slate-500">{{ t('settings.backupsOnDisk') }}</p>
            <p class="font-medium text-slate-300">{{ systemStatus.backupCount }}</p>
          </div>
          <div>
            <p class="text-xs text-slate-500">{{ t('settings.whatsapp') }}</p>
            <p
              class="font-medium text-xs"
              :class="systemStatus.whatsappConfigured ? 'text-farm-green' : 'text-slate-500'"
            >
              {{ systemStatus.whatsappConfigured ? t('settings.configured') : t('settings.notConfigured') }}
            </p>
          </div>
          <div>
            <p class="text-xs text-slate-500">{{ t('settings.aiMode') }}</p>
            <p class="font-medium text-slate-300 text-xs capitalize">{{ systemStatus.aiMode }}</p>
          </div>
          <div>
            <p class="text-xs text-slate-500">{{ t('settings.environment') }}</p>
            <p class="font-medium text-slate-300 text-xs">{{ systemStatus.env }}</p>
          </div>
          <div>
            <p class="text-xs text-slate-500">{{ t('settings.version') }}</p>
            <p class="font-medium text-slate-300 text-xs font-mono">{{ systemStatus.commit }}</p>
          </div>
        </div>
      </div>

      <!-- Integrations -->
      <div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h3 class="font-bold text-white text-sm">{{ t('settings.aiIntegration') }}</h3>
          <p class="text-xs mt-2">
            <span
              class="font-bold px-2 py-0.5 rounded-full"
              :class="aiStatus?.configured ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-400'"
            >
              {{ aiStatus?.configured ? t('settings.configured') : t('settings.notConfigured') }}
            </span>
          </p>
          <p v-if="aiStatus?.hint" class="text-xs text-slate-500 mt-2">{{ aiStatus.hint }}</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h3 class="font-bold text-white text-sm">{{ t('settings.whatsappIntegration') }}</h3>
          <p class="text-xs mt-2">
            <span
              class="font-bold px-2 py-0.5 rounded-full"
              :class="whatsappStatus?.configured ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-400'"
            >
              {{ whatsappStatus?.configured ? t('settings.configured') : t('settings.notConfigured') }}
            </span>
          </p>
          <p v-if="whatsappStatus?.hint" class="text-xs text-slate-500 mt-2">{{ whatsappStatus.hint }}</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h3 class="font-bold text-white text-sm">{{ t('settings.telegramConnect') }}</h3>
          <p class="text-xs text-slate-400 mt-2">
            {{ t('settings.telegramDesc') }}
          </p>
          <span
            class="inline-flex mt-2 text-xs font-bold px-2 py-0.5 rounded-full"
            :class="telegramLinked ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-400'"
          >
            {{ telegramLinked ? t('settings.telegramLinked') : t('settings.notLinked') }}
          </span>
          <a
            href="https://t.me/TrovaraButlerBot"
            target="_blank"
            rel="noopener noreferrer"
            class="mt-3 inline-flex text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-farm-green hover:bg-slate-700"
          >
            {{ t('settings.openBot') }}
          </a>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              class="text-xs font-bold px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
              :disabled="generatingLinkCode"
              @click="generateButlerLinkCode"
            >
              {{ generatingLinkCode ? t('settings.generating') : t('settings.generateLinkCode') }}
            </button>
            <button
              v-if="linkCode"
              type="button"
              class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
              @click="copyLinkCode"
            >
              {{ t('settings.copyCode') }}
            </button>
            <button
              type="button"
              class="text-xs font-bold px-3 py-1.5 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60 disabled:opacity-50"
              :disabled="revokingTelegram || !telegramLinked"
              @click="revokeTelegramLink"
            >
              {{ revokingTelegram ? t('settings.revoking') : t('settings.revokeTelegram') }}
            </button>
          </div>
          <div v-if="linkCode" class="mt-4 rounded-xl border border-farm-green/30 bg-slate-950/60 p-4 text-center">
            <p class="text-xs text-slate-500">{{ t('settings.sendToTelegram', { code: linkCode }) }}</p>
            <p class="mt-2 text-3xl font-black font-mono tracking-[0.3em] text-farm-gold">{{ linkCode }}</p>
            <p v-if="linkCodeRemaining" class="mt-2 text-xs text-amber-300">
              {{ t('settings.expiresIn', { time: linkCodeRemaining }) }}
            </p>
          </div>
          <p v-if="linkCodeMessage" class="mt-2 text-xs text-slate-400">{{ linkCodeMessage }}</p>
          <p v-if="telegramMessage" class="mt-1 text-xs text-slate-400">{{ telegramMessage }}</p>
        </div>
      </div>

      <div class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <h3 class="font-bold text-white text-sm">{{ t('settings.founderSecurity') }}</h3>
        <div class="flex items-center gap-3">
          <span
            class="text-xs font-bold px-2.5 py-1 rounded-full"
            :class="totpStatus?.enabled ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-400'"
          >
            {{ totpStatus?.enabled ? t('settings.twoFaEnabled') : t('settings.twoFaDisabled') }}
          </span>
          <button
            type="button"
            class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-50"
            :disabled="totpLoading"
            @click="setupTotp"
          >
            {{ totpLoading ? t('settings.preparing') : totpStatus?.enabled ? t('settings.rotateSecret') : t('settings.setupAuthenticator') }}
          </button>
        </div>

        <div v-if="totpSetup" class="rounded-xl border border-slate-700 bg-slate-950/50 p-4">
          <p class="text-xs text-slate-400">{{ t('settings.scanQr') }}</p>
          <img :src="totpSetup.qrUrl" alt="TOTP QR code" class="mt-3 h-40 w-40 rounded-lg border border-slate-700 bg-white p-1" />
          <p class="mt-2 text-[11px] text-slate-500 break-all">{{ t('settings.secretLabel') }} <span class="font-mono">{{ totpSetup.secret }}</span></p>
          <a
            :href="totpSetup.otpAuthUrl"
            class="mt-1 inline-flex text-[11px] text-farm-green hover:underline break-all"
          >
            {{ t('settings.openOtpauth') }}
          </a>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <input
            v-model="totpCode"
            type="text"
            inputmode="numeric"
            maxlength="6"
            placeholder="123456"
            class="w-36 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm tracking-[0.2em] text-center text-white"
          />
          <button
            type="button"
            class="text-xs font-bold px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
            :disabled="totpLoading || !totpSetup"
            @click="enableTotp"
          >
            {{ t('settings.enable2fa') }}
          </button>
          <input
            v-model="totpDisablePassword"
            type="password"
            :placeholder="t('settings.disable2faPassword')"
            class="w-full max-w-xs bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <button
            type="button"
            class="text-xs font-bold px-3 py-2 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60 disabled:opacity-50"
            :disabled="totpLoading || !totpStatus?.enabled"
            @click="disableTotp"
          >
            {{ t('settings.disable2fa') }}
          </button>
        </div>
        <p v-if="totpMessage" class="text-xs text-slate-400">{{ totpMessage }}</p>
      </div>

      <div class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
        <h3 class="font-bold text-white text-sm">{{ t('settings.butlerVoiceMode') }}</h3>
        <p class="text-xs text-slate-500">{{ t('settings.butlerVoiceDesc') }}</p>
        <div class="flex flex-wrap items-center gap-3">
          <select
            v-model="ttsMode"
            class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="off">{{ t('settings.ttsOff') }}</option>
            <option value="voice_replies">{{ t('settings.ttsVoiceReplies') }}</option>
            <option value="always">{{ t('settings.ttsAlways') }}</option>
          </select>
          <button
            type="button"
            class="text-xs font-bold px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
            :disabled="savingTtsMode"
            @click="saveButlerTtsMode"
          >
            {{ savingTtsMode ? t('settings.saving') : t('settings.saveMode') }}
          </button>
        </div>
        <p v-if="ttsMessage" class="text-xs text-slate-400">{{ ttsMessage }}</p>
      </div>

      <!-- SaaS Billing -->
      <div v-if="billingStatus" class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h3 class="font-bold text-white text-sm">{{ t('settings.saasBilling') }}</h3>
        <p class="text-xs text-slate-400 mt-2">{{ billingStatus.message }}</p>
        <p class="text-xs mt-2">
          <span class="font-bold px-2 py-0.5 rounded-full bg-slate-700 text-slate-400">
            {{ billingStatus.enabled ? t('settings.billingEnabled') : t('settings.billingPlaceholder') }}
          </span>
        </p>
        <ul class="mt-3 space-y-1 text-xs text-slate-500">
          <li v-for="(step, key) in billingStatus.roadmap" :key="key">
            <span class="text-slate-400 capitalize">{{ key }}:</span> {{ step }}
          </li>
        </ul>
        <p class="text-xs text-farm-green mt-3">{{ t('settings.seeDocs', { docs: billingStatus.docs }) }}</p>
      </div>

      <div class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h3 class="font-bold text-white text-sm">{{ t('settings.csvExports') }}</h3>
        <p class="text-xs text-slate-500 mt-1">{{ t('settings.csvDesc') }}</p>
        <div class="mt-4 flex flex-wrap gap-2">
          <a
            href="/api/exports/tasks.csv"
            class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            {{ t('settings.exportTasksCsv') }}
          </a>
          <a
            href="/api/exports/inventory.csv"
            class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            {{ t('settings.exportInventoryCsv') }}
          </a>
          <a
            href="/api/exports/expenses.csv"
            class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            {{ t('settings.exportExpensesCsv') }}
          </a>
          <a
            href="/api/exports/audit.csv"
            class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            {{ t('settings.exportAuditCsv') }}
          </a>
        </div>
      </div>

      <div class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h3 class="font-bold text-white text-sm">{{ t('settings.privacy') }}</h3>
        <p class="text-xs text-slate-500 mt-1">{{ t('settings.privacyDesc') }}</p>
        <div class="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            class="text-xs font-bold px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
            :disabled="exportingFarmData"
            @click="exportFarmData"
          >
            {{ exportingFarmData ? t('settings.exporting') : t('settings.exportFarmData') }}
          </button>
          <a
            href="/ndpa-compliance.md"
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            {{ t('settings.ndpaDoc') }}
          </a>
        </div>
        <p v-if="farmExportMessage" class="mt-2 text-xs text-slate-400">{{ farmExportMessage }}</p>
      </div>

      <!-- Admin actions -->
      <div class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <h3 class="font-bold text-white text-sm">{{ t('settings.adminActions') }}</h3>
        <div class="flex flex-wrap gap-3">
          <button
            v-if="auth.isOwner && !liveMode"
            type="button"
            class="text-sm font-bold px-4 py-2 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60 disabled:opacity-50"
            :disabled="resetting"
            @click="openResetConfirm"
          >
            {{ resetting ? t('settings.resetting') : t('settings.resetDemoData') }}
          </button>
          <p
            v-else-if="auth.isOwner && liveMode"
            class="text-xs px-3 py-2 rounded-lg border border-slate-800 text-slate-500"
          >
            {{ t('settings.resetDisabledLive') }}
          </p>
          <button
            type="button"
            class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
            :disabled="generating"
            @click="generateTasks"
          >
            {{ generating ? t('settings.generating') : t('settings.generateDueTasks') }}
          </button>
          <button
            type="button"
            class="text-sm font-bold px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-50"
            :disabled="revokingSessions"
            @click="revokeAllOtherSessions"
          >
            {{ revokingSessions ? t('settings.revoking') : t('settings.logoutAllDevices') }}
          </button>
        </div>
        <p v-if="resetMessage" class="text-xs text-slate-400">{{ resetMessage }}</p>
        <p v-if="generateMessage" class="text-xs text-slate-400">{{ generateMessage }}</p>
        <p v-if="revokeMessage" class="text-xs text-slate-400">{{ revokeMessage }}</p>
        <p class="text-xs text-slate-600 mt-2">
          Backup: <code class="font-mono">./scripts/backup-db.sh</code> ·
          Restore: <code class="font-mono">./scripts/restore-db.sh &lt;file&gt;</code> ·
          Verify: <code class="font-mono">./scripts/verify-backup.sh</code>
        </p>
        <p class="text-xs text-slate-500">
          {{ t('settings.privacyNotice') }}
          <a
            href="https://trovara.farm/privacy"
            target="_blank"
            rel="noopener noreferrer"
            class="text-farm-green hover:underline"
          >
            https://trovara.farm/privacy
          </a>
        </p>
      </div>
    </template>

    <!-- Reset demo data: destructive, Founder-only, type-to-confirm -->
    <div
      v-if="showResetConfirm && auth.isOwner"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div class="absolute inset-0 bg-black/70" @click="cancelResetConfirm" />
      <div class="relative w-full max-w-md rounded-2xl border border-red-800/50 bg-slate-900 p-6 shadow-2xl">
        <h3 class="text-lg font-black text-red-300">{{ t('settings.resetConfirmTitle') }}</h3>
        <p class="mt-2 text-sm text-slate-300">
          {{ t('settings.resetConfirmBody') }}
          <span class="font-semibold text-red-300">{{ t('settings.resetCannotUndo') }}</span>
        </p>
        <label class="mt-4 block text-xs font-semibold text-slate-400">
          {{ t('settings.typeToConfirm', { phrase: RESET_CONFIRM_PHRASE }) }}
        </label>
        <input
          v-model="resetConfirmText"
          type="text"
          autocomplete="off"
          :placeholder="RESET_CONFIRM_PHRASE"
          class="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-red-500 focus:outline-none"
          @keyup.enter="resetDemo"
        />
        <div class="mt-5 flex justify-end gap-3">
          <button
            type="button"
            class="text-sm font-semibold px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
            @click="cancelResetConfirm"
          >
            {{ t('settings.cancel') }}
          </button>
          <button
            type="button"
            class="text-sm font-bold px-4 py-2 rounded-lg bg-red-700 text-white hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="!resetConfirmValid || resetting"
            @click="resetDemo"
          >
            {{ resetting ? t('settings.resetting') : t('settings.resetData') }}
          </button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
