<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { RegistrationTokenRow } from '@/composables/useSettingsRegistrationTokens'

defineProps<{
  tokens: RegistrationTokenRow[]
  loading: boolean
  creating: boolean
  revokingId: string | null
  message: string | null
  createdPlaintext: string | null
}>()

const label = defineModel<string>('label', { required: true })
const ttlHours = defineModel<number>('ttlHours', { required: true })

const emit = defineEmits<{
  create: []
  copy: []
  revoke: [id: string]
}>()

const { t } = useI18n()

function statusLabel(status: RegistrationTokenRow['status']): string {
  switch (status) {
    case 'valid':
      return t('settings.regTokenStatusValid')
    case 'used':
      return t('settings.regTokenStatusUsed')
    case 'expired':
      return t('settings.regTokenStatusExpired')
    case 'revoked':
      return t('settings.regTokenStatusRevoked')
    default:
      return status
  }
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso.slice(0, 10)
  }
}
</script>

<template>
  <div class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
    <div>
      <h3 class="font-bold text-white text-sm">{{ t('settings.regTokensTitle') }}</h3>
      <p class="text-xs text-slate-500 mt-1">{{ t('settings.regTokensDesc') }}</p>
    </div>

    <div class="flex flex-wrap items-end gap-2">
      <label class="block text-xs text-slate-400">
        {{ t('settings.regTokenLabel') }}
        <input
          v-model="label"
          type="text"
          maxlength="200"
          class="mt-1 w-full min-w-[12rem] rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
          :placeholder="t('settings.regTokenLabelPlaceholder')"
        />
      </label>
      <label class="block text-xs text-slate-400">
        {{ t('settings.regTokenTtl') }}
        <input
          v-model.number="ttlHours"
          type="number"
          min="1"
          max="720"
          class="mt-1 w-24 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
        />
      </label>
      <button
        type="button"
        class="text-xs font-bold px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
        :disabled="creating"
        @click="emit('create')"
      >
        {{ creating ? t('settings.creating') : t('settings.createRegToken') }}
      </button>
    </div>

    <div
      v-if="createdPlaintext"
      class="rounded-xl border border-farm-green/40 bg-farm-green/10 p-3 space-y-2"
    >
      <p class="text-xs text-farm-green font-bold">{{ t('settings.regTokenShowOnce') }}</p>
      <p class="text-sm font-mono text-white break-all">{{ createdPlaintext }}</p>
      <button
        type="button"
        class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700"
        @click="emit('copy')"
      >
        {{ t('settings.copyRegToken') }}
      </button>
    </div>

    <p v-if="loading" class="text-xs text-slate-500">{{ t('settings.loading') }}</p>

    <ul v-else-if="tokens.length" class="space-y-2">
      <li
        v-for="row in tokens"
        :key="row.id"
        class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2"
      >
        <div class="min-w-0">
          <p class="text-sm text-white truncate">
            {{ row.label?.trim() || t('settings.regTokenUntitled') }}
          </p>
          <p class="text-[11px] text-slate-500 mt-0.5">
            {{ t('settings.regTokenExpires', { when: formatWhen(row.expiresAt) }) }}
            · {{ statusLabel(row.status) }}
            <span v-if="row.usedByEmail"> · {{ row.usedByEmail }}</span>
          </p>
        </div>
        <button
          v-if="row.status === 'valid'"
          type="button"
          class="text-xs font-bold px-3 py-1.5 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60 disabled:opacity-50"
          :disabled="revokingId === row.id"
          @click="emit('revoke', row.id)"
        >
          {{ revokingId === row.id ? t('settings.revoking') : t('settings.revokeRegToken') }}
        </button>
      </li>
    </ul>
    <p v-else class="text-xs text-slate-500">{{ t('settings.regTokensEmpty') }}</p>

    <p v-if="message" class="text-xs text-slate-400">{{ message }}</p>
  </div>
</template>
