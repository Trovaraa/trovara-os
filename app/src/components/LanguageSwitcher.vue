<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { persistLocale, type AppLocale } from '@/i18n'

defineProps<{ compact?: boolean }>()

const { locale } = useI18n()

const options: { code: AppLocale; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'yo', label: 'YO' },
  { code: 'pcm', label: 'PCM' },
]

function setLocale(code: AppLocale) {
  locale.value = code
  persistLocale(code)
  document.documentElement.lang = code === 'pcm' ? 'en' : code
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
