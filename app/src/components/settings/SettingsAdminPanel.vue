<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  liveMode: boolean
  resetting: boolean
  resetMessage: string | null
  showResetConfirm: boolean
  resetConfirmValid: boolean
  resetConfirmPhrase: string
  generating: boolean
  generateMessage: string | null
  revokingSessions: boolean
  revokeMessage: string | null
}>()

const resetConfirmText = defineModel<string>('resetConfirmText', { required: true })

const emit = defineEmits<{
  'open-reset': []
  'cancel-reset': []
  'confirm-reset': []
  'generate-tasks': []
  'revoke-sessions': []
}>()

const { t } = useI18n()
</script>

<template>
  <div class="contents">
    <div class="mt-8 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
      <h3 class="font-bold text-white text-sm">{{ t('settings.adminActions') }}</h3>
      <div class="flex flex-wrap gap-3">
        <button
          v-if="!liveMode"
          type="button"
          class="text-sm font-bold px-4 py-2 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60 disabled:opacity-50"
          :disabled="resetting"
          @click="emit('open-reset')"
        >
          {{ resetting ? t('settings.resetting') : t('settings.resetDemoData') }}
        </button>
        <p
          v-else
          class="text-xs px-3 py-2 rounded-lg border border-slate-800 text-slate-500"
        >
          {{ t('settings.resetDisabledLive') }}
        </p>
        <button
          type="button"
          class="text-sm font-bold px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
          :disabled="generating"
          @click="emit('generate-tasks')"
        >
          {{ generating ? t('settings.generating') : t('settings.generateDueTasks') }}
        </button>
        <button
          type="button"
          class="text-sm font-bold px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-50"
          :disabled="revokingSessions"
          @click="emit('revoke-sessions')"
        >
          {{ revokingSessions ? t('settings.revoking') : t('settings.logoutAllDevices') }}
        </button>
      </div>
      <p v-if="resetMessage" class="text-xs text-slate-400">{{ resetMessage }}</p>
      <p v-if="generateMessage" class="text-xs text-slate-400">{{ generateMessage }}</p>
      <p v-if="revokeMessage" class="text-xs text-slate-400">{{ revokeMessage }}</p>
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

    <div
      v-if="showResetConfirm"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div class="absolute inset-0 bg-black/70" @click="emit('cancel-reset')" />
      <div class="relative w-full max-w-md rounded-2xl border border-red-800/50 bg-slate-900 p-6 shadow-2xl">
        <h3 class="text-lg font-black text-red-300">{{ t('settings.resetConfirmTitle') }}</h3>
        <p class="mt-2 text-sm text-slate-300">
          {{ t('settings.resetConfirmBody') }}
          <span class="font-semibold text-red-300">{{ t('settings.resetCannotUndo') }}</span>
        </p>
        <label class="mt-4 block text-xs font-semibold text-slate-400">
          {{ t('settings.typeToConfirm', { phrase: resetConfirmPhrase }) }}
        </label>
        <input
          v-model="resetConfirmText"
          type="text"
          autocomplete="off"
          :placeholder="resetConfirmPhrase"
          class="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-red-500 focus:outline-none"
          @keyup.enter="emit('confirm-reset')"
        />
        <div class="mt-5 flex justify-end gap-3">
          <button
            type="button"
            class="text-sm font-semibold px-4 py-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
            @click="emit('cancel-reset')"
          >
            {{ t('settings.cancel') }}
          </button>
          <button
            type="button"
            class="text-sm font-bold px-4 py-2 rounded-lg bg-red-700 text-white hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="!resetConfirmValid || resetting"
            @click="emit('confirm-reset')"
          >
            {{ resetting ? t('settings.resetting') : t('settings.resetData') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
