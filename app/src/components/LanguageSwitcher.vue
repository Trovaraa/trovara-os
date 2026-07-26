<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { type AppLocale } from '@/i18n'
import { applyLocale, useAuthStore } from '@/stores/auth'

defineProps<{ compact?: boolean }>()

const { locale } = useI18n()
const auth = useAuthStore()

const options: { code: AppLocale; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'yo', label: 'YO' },
  { code: 'pcm', label: 'PCM' },
  { code: 'fr', label: 'FR' },
]

function setLocale(code: AppLocale) {
  if (locale.value === code) return
  applyLocale(code)
  // Mirror onto the profile so AI content and TG/WhatsApp messages follow the UI.
  // Best-effort: signed-out, offline, or a rejected write must not revert the switch.
  auth.savePreferredLocale(code).catch(() => undefined)
}
</script>

<template>
  <div
    class="inline-flex rounded-lg bg-slate-800/80 border border-slate-700 p-0.5 shrink-0"
    role="group"
    :aria-label="$t('common.language')"
  >
    <button
      v-for="opt in options"
      :key="opt.code"
      type="button"
      class="font-bold rounded-md transition-colors"
      :class="[
        compact
          ? 'min-w-[1.75rem] min-h-[1.75rem] px-1 text-[10px]'
          : 'min-w-[2.5rem] min-h-[2.25rem] px-2 text-xs',
        locale === opt.code
          ? 'bg-farm-green text-white'
          : 'text-slate-400 hover:text-white',
      ]"
      :aria-pressed="locale === opt.code"
      @click="setLocale(opt.code)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>
