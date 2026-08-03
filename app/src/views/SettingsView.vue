<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import SettingsAdminPanel from '@/components/settings/SettingsAdminPanel.vue'
import SettingsAiStatusCard from '@/components/settings/SettingsAiStatusCard.vue'
import SettingsChannelsPanel from '@/components/settings/SettingsChannelsPanel.vue'
import SettingsFarmPanel from '@/components/settings/SettingsFarmPanel.vue'
import SettingsGoLivePanel from '@/components/settings/SettingsGoLivePanel.vue'
import SettingsOpsPanel from '@/components/settings/SettingsOpsPanel.vue'
import SettingsPreferencesPanel from '@/components/settings/SettingsPreferencesPanel.vue'
import SettingsPrivacyPanel from '@/components/settings/SettingsPrivacyPanel.vue'
import SettingsRegistrationTokensPanel from '@/components/settings/SettingsRegistrationTokensPanel.vue'
import SettingsSystemStatusPanel from '@/components/settings/SettingsSystemStatusPanel.vue'
import SettingsTotpPanel from '@/components/settings/SettingsTotpPanel.vue'
import { useSettingsAdmin } from '@/composables/useSettingsAdmin'
import { useSettingsChannels } from '@/composables/useSettingsChannels'
import { useSettingsFarm } from '@/composables/useSettingsFarm'
import { useSettingsOnboarding } from '@/composables/useSettingsOnboarding'
import { useSettingsPreferences } from '@/composables/useSettingsPreferences'
import { useSettingsPrivacy } from '@/composables/useSettingsPrivacy'
import { useSettingsRegistrationTokens } from '@/composables/useSettingsRegistrationTokens'
import { useSettingsTotp } from '@/composables/useSettingsTotp'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import type { SystemStatus } from '@/types/system-status'

const { t } = useI18n()

type IntegrationStatus = {
  configured: boolean
  hint?: string
}

const auth = useAuthStore()
const loading = ref(true)
const aiStatus = ref<IntegrationStatus | null>(null)
const whatsappStatus = ref<IntegrationStatus | null>(null)
const systemStatus = ref<SystemStatus | null>(null)

const {
  farmProfile,
  farmName,
  farmLocation,
  farmLatitude,
  farmLongitude,
  farmTimezone,
  savingFarm,
  farmMessage,
  loadFarm,
  saveFarmLocation,
} = useSettingsFarm(() => auth.isOwner)

const {
  retentionStatus,
  retentionLoading,
  retentionRunning,
  retentionMessage,
  anonymizeTargets,
  selectedWorkerId,
  selectedContactId,
  anonymizingWorker,
  anonymizingContact,
  anonymizeMessage,
  exportingFarmData,
  farmExportMessage,
  exportReason,
  loadPrivacyPanels,
  runRetentionNow,
  anonymizeSelectedWorker,
  anonymizeSelectedContact,
  exportFarmData,
} = useSettingsPrivacy(() => auth.isOwner)

const {
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
} = useSettingsChannels()

const {
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
} = useSettingsPreferences()

const {
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
} = useSettingsTotp(async () => {
  await loadTotp()
})

const {
  tokens: regTokens,
  loading: regTokensLoading,
  creating: creatingRegToken,
  revokingId: revokingRegTokenId,
  message: regTokensMessage,
  createdPlaintext: createdRegToken,
  label: regTokenLabel,
  ttlHours: regTokenTtlHours,
  loadTokens: loadRegTokens,
  createToken: createRegToken,
  revokeToken: revokeRegToken,
  copyCreatedToken: copyCreatedRegToken,
} = useSettingsRegistrationTokens(() => auth.isOwner)

async function load() {
  loading.value = true
  try {
    const [aiData, waData] = await Promise.all([
      api<IntegrationStatus>('/api/ai/status').catch(() => null),
      api<IntegrationStatus>('/api/whatsapp/status').catch(() => null),
    ])
    aiStatus.value = aiData
    whatsappStatus.value = waData

    if (auth.isOwner) {
      await Promise.all([
        loadOnboarding(),
        loadFarm(),
        loadPrivacyPanels(),
        loadRegTokens(),
      ])
      try {
        systemStatus.value = await api<SystemStatus>('/system-status')
      } catch {
        systemStatus.value = null
      }
    }

    await Promise.all([loadTotp(), loadPreferences(), loadChannels()])
  } finally {
    loading.value = false
  }
}

const {
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
} = useSettingsOnboarding(
  () => auth.isOwner,
  farmName,
  () => farmProfile.value?.name,
  load,
)

const {
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
} = useSettingsAdmin(() => auth.isOwner, () => auth.logout(), load)

onMounted(load)
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-os-fg">{{ t('settings.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1">
        {{ auth.isOwner ? t('settings.subtitle') : t('settings.subtitleStaff') }}
      </p>
      <RouterLink
        v-if="auth.isOwner"
        to="/settings/security"
        class="inline-flex mt-3 text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-farm-green hover:bg-slate-700"
      >
        {{ t('settings.securityDashboard') }}
      </RouterLink>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('settings.loading') }}</div>

    <template v-else>
      <SettingsFarmPanel
        v-if="auth.isOwner"
        v-model:farm-name="farmName"
        v-model:farm-location="farmLocation"
        v-model:farm-latitude="farmLatitude"
        v-model:farm-longitude="farmLongitude"
        v-model:farm-timezone="farmTimezone"
        :saving-farm="savingFarm"
        :farm-message="farmMessage"
        @save="saveFarmLocation"
      />

      <SettingsGoLivePanel
        v-if="auth.isOwner"
        :go-live-ready="goLiveReady"
        :go-live-done-count="goLiveDoneCount"
        :go-live-items="goLiveItems"
        :live-mode="liveMode"
        :going-live="goingLive"
        :go-live-message="goLiveMessage"
        :ready="ready"
        :checklist="checklist"
        @go-live="goLive"
      />

      <SettingsSystemStatusPanel v-if="auth.isOwner && systemStatus" :system-status="systemStatus" />

      <div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SettingsAiStatusCard :configured="aiStatus?.configured" :hint="aiStatus?.hint" />
        <SettingsChannelsPanel
          v-model:my-phone="myPhone"
          :whatsapp-configured="whatsappStatus?.configured"
          :generating-link-code="generatingLinkCode"
          :link-code="linkCode"
          :link-code-remaining="linkCodeRemaining"
          :link-code-message="linkCodeMessage"
          :telegram-linked="telegramLinked"
          :revoking-telegram="revokingTelegram"
          :telegram-message="telegramMessage"
          :saving-phone="savingPhone"
          :phone-message="phoneMessage"
          @save-phone="saveMyPhone"
          @generate-link="generateButlerLinkCode"
          @copy-link="copyLinkCode"
          @revoke-telegram="revokeTelegramLink"
        />
      </div>

      <SettingsTotpPanel
        v-model:totp-code="totpCode"
        v-model:totp-disable-password="totpDisablePassword"
        :totp-status="totpStatus"
        :totp-setup="totpSetup"
        :totp-loading="totpLoading"
        :totp-message="totpMessage"
        @setup="setupTotp"
        @enable="enableTotp"
        @disable="disableTotp"
      />

      <SettingsRegistrationTokensPanel
        v-if="auth.isOwner"
        v-model:label="regTokenLabel"
        v-model:ttl-hours="regTokenTtlHours"
        :tokens="regTokens"
        :loading="regTokensLoading"
        :creating="creatingRegToken"
        :revoking-id="revokingRegTokenId"
        :message="regTokensMessage"
        :created-plaintext="createdRegToken"
        @create="createRegToken"
        @copy="copyCreatedRegToken"
        @revoke="revokeRegToken"
      />

      <SettingsPreferencesPanel
        :is-owner="auth.isOwner"
        v-model:tts-mode="ttsMode"
        v-model:order-alerts-subscribed="orderAlertsSubscribed"
        v-model:worker-alerts-subscribed="workerAlertsSubscribed"
        :saving-order-alerts="savingOrderAlerts"
        :saving-worker-alerts="savingWorkerAlerts"
        :order-alerts-message="orderAlertsMessage"
        :worker-alerts-message="workerAlertsMessage"
        :saving-tts-mode="savingTtsMode"
        :tts-message="ttsMessage"
        @save-tts="saveButlerTtsMode"
        @save-order-alerts="saveOrderAlertsPreference"
        @save-worker-alerts="saveWorkerAlertsPreference"
      />

      <SettingsOpsPanel v-if="auth.isOwner" :billing-status="billingStatus" />

      <SettingsPrivacyPanel
        v-if="auth.isOwner"
        v-model:export-reason="exportReason"
        v-model:selected-worker-id="selectedWorkerId"
        v-model:selected-contact-id="selectedContactId"
        :retention-status="retentionStatus"
        :retention-loading="retentionLoading"
        :retention-running="retentionRunning"
        :retention-message="retentionMessage"
        :anonymize-targets="anonymizeTargets"
        :anonymizing-worker="anonymizingWorker"
        :anonymizing-contact="anonymizingContact"
        :anonymize-message="anonymizeMessage"
        :exporting-farm-data="exportingFarmData"
        :farm-export-message="farmExportMessage"
        @export="exportFarmData"
        @run-retention="runRetentionNow"
        @anonymize-worker="anonymizeSelectedWorker"
        @anonymize-contact="anonymizeSelectedContact"
      />

      <SettingsAdminPanel
        v-if="auth.isOwner"
        v-model:reset-confirm-text="resetConfirmText"
        :live-mode="liveMode"
        :resetting="resetting"
        :reset-message="resetMessage"
        :show-reset-confirm="showResetConfirm"
        :reset-confirm-valid="resetConfirmValid"
        :reset-confirm-phrase="RESET_CONFIRM_PHRASE"
        :generating="generating"
        :generate-message="generateMessage"
        :revoking-sessions="revokingSessions"
        :revoke-message="revokeMessage"
        @open-reset="openResetConfirm"
        @cancel-reset="cancelResetConfirm"
        @confirm-reset="resetDemo"
        @generate-tasks="generateTasks"
        @revoke-sessions="revokeAllOtherSessions"
      />
    </template>
  </AppLayout>
</template>
