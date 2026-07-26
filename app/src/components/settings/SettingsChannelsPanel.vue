<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  whatsappConfigured: boolean | undefined
  generatingLinkCode: boolean
  linkCode: string | null
  linkCodeRemaining: string
  linkCodeMessage: string | null
  telegramLinked: boolean
  revokingTelegram: boolean
  telegramMessage: string | null
  savingPhone: boolean
  phoneMessage: string | null
}>()

const myPhone = defineModel<string>('myPhone', { required: true })

const emit = defineEmits<{
  'save-phone': []
  'generate-link': []
  'copy-link': []
  'revoke-telegram': []
}>()

const { t } = useI18n()
</script>

<template>
  <div class="contents">
    <div class="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <h3 class="font-bold text-white text-sm">{{ t('settings.whatsappConnect') }}</h3>
      <p class="text-xs text-slate-400 mt-2">
        {{ t('settings.whatsappConnectDesc') }}
      </p>
      <span
        class="inline-flex mt-2 text-xs font-bold px-2 py-0.5 rounded-full"
        :class="whatsappConfigured ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-400'"
      >
        {{ whatsappConfigured ? t('settings.configured') : t('settings.notConfigured') }}
      </span>
      <label class="block text-xs text-slate-500 mt-3 mb-1">{{ t('settings.yourPhone') }}</label>
      <div class="flex flex-wrap gap-2">
        <input
          v-model="myPhone"
          type="tel"
          :placeholder="t('settings.phonePlaceholder')"
          class="flex-1 min-w-[10rem] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono"
        />
        <button
          type="button"
          class="text-xs font-bold px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
          :disabled="savingPhone"
          @click="emit('save-phone')"
        >
          {{ savingPhone ? t('settings.saving') : t('settings.savePhone') }}
        </button>
      </div>
      <p class="text-xs text-slate-500 mt-2">{{ t('settings.whatsappPhoneHint') }}</p>
      <p v-if="phoneMessage" class="mt-2 text-xs text-slate-400">{{ phoneMessage }}</p>
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
          @click="emit('generate-link')"
        >
          {{ generatingLinkCode ? t('settings.generating') : t('settings.generateLinkCode') }}
        </button>
        <button
          v-if="linkCode"
          type="button"
          class="text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
          @click="emit('copy-link')"
        >
          {{ t('settings.copyCode') }}
        </button>
        <button
          type="button"
          class="text-xs font-bold px-3 py-1.5 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60 disabled:opacity-50"
          :disabled="revokingTelegram || !telegramLinked"
          @click="emit('revoke-telegram')"
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
  </div>
</template>
