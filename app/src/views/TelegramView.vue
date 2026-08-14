<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { useSettingsChannels } from '@/composables/useSettingsChannels'

const { t } = useI18n()
const {
  generatingLinkCode,
  linkCode,
  linkCodeRemaining,
  linkCodeMessage,
  telegramLinked,
  revokingTelegram,
  telegramMessage,
  loadChannels,
  generateButlerLinkCode,
  copyLinkCode,
  revokeTelegramLink,
} = useSettingsChannels()

onMounted(loadChannels)
</script>

<template>
  <AppLayout>
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-black text-os-fg">{{ t('telegram.title') }}</h2>
        <p class="text-slate-400 text-sm mt-1">{{ t('telegram.subtitle') }}</p>
      </div>
      <span
        class="text-xs font-bold px-2.5 py-1 rounded-full shrink-0"
        :class="telegramLinked ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-400'"
      >
        {{ telegramLinked ? t('settings.telegramLinked') : t('settings.notLinked') }}
      </span>
    </div>

    <div class="mt-8 max-w-xl bg-slate-900 border border-slate-800 rounded-xl p-5">
      <h3 class="font-bold text-white text-sm">{{ t('settings.telegramConnect') }}</h3>
      <p class="text-xs text-slate-400 mt-2">{{ t('settings.telegramDesc') }}</p>
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
      <div
        v-if="linkCode"
        class="mt-4 rounded-xl border border-farm-green/30 bg-slate-950/60 p-4 text-center"
      >
        <p class="text-xs text-slate-500">{{ t('settings.sendToTelegram', { code: linkCode }) }}</p>
        <p class="mt-2 text-3xl font-black font-mono tracking-[0.3em] text-farm-gold">{{ linkCode }}</p>
        <p v-if="linkCodeRemaining" class="mt-2 text-xs text-amber-300">
          {{ t('settings.expiresIn', { time: linkCodeRemaining }) }}
        </p>
      </div>
      <p v-if="linkCodeMessage" class="mt-2 text-xs text-slate-400">{{ linkCodeMessage }}</p>
      <p v-if="telegramMessage" class="mt-1 text-xs text-slate-400">{{ telegramMessage }}</p>
    </div>
  </AppLayout>
</template>
