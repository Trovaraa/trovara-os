<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { getActiveTheme, setTheme, type ThemeMode } from '@/lib/theme'

defineProps<{ compact?: boolean; toggleOnly?: boolean }>()

const { t } = useI18n()
const mode = ref<ThemeMode>('dark')

onMounted(() => {
  mode.value = getActiveTheme()
})

function select(next: ThemeMode) {
  if (mode.value === next) return
  setTheme(next)
  mode.value = next
}

function toggle() {
  select(mode.value === 'dark' ? 'light' : 'dark')
}
</script>

<template>
  <button
    v-if="toggleOnly"
    type="button"
    class="h-9 w-9 shrink-0 rounded-lg border transition-colors grid place-items-center"
    :class="
      mode === 'dark'
        ? 'bg-farm-green text-white border-farm-green'
        : 'bg-slate-100 text-slate-700 border-slate-200'
    "
    :aria-label="mode === 'dark' ? t('common.themeLight') : t('common.themeDark')"
    :title="mode === 'dark' ? t('common.themeLight') : t('common.themeDark')"
    @click="toggle"
  >
    <svg v-if="mode === 'dark'" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
    </svg>
    <svg v-else class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
      />
    </svg>
  </button>
  <div
    v-else
    class="inline-flex rounded-lg border p-0.5 shrink-0"
    :class="mode === 'light' ? 'bg-slate-100 border-slate-200' : 'bg-slate-800/80 border-slate-700'"
    role="group"
    :aria-label="t('common.theme')"
  >
    <button
      type="button"
      class="rounded-md transition-colors grid place-items-center"
      :class="[
        compact ? 'h-7 w-7' : 'h-9 w-9',
        mode === 'dark'
          ? 'bg-farm-green text-white'
          : 'text-slate-500 hover:text-slate-800',
      ]"
      :aria-pressed="mode === 'dark'"
      :aria-label="t('common.themeDark')"
      :title="t('common.themeDark')"
      @click="select('dark')"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
      </svg>
    </button>
    <button
      type="button"
      class="rounded-md transition-colors grid place-items-center"
      :class="[
        compact ? 'h-7 w-7' : 'h-9 w-9',
        mode === 'light'
          ? 'bg-farm-green text-white'
          : 'text-slate-400 hover:text-white',
      ]"
      :aria-pressed="mode === 'light'"
      :aria-label="t('common.themeLight')"
      :title="t('common.themeLight')"
      @click="select('light')"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
        />
      </svg>
    </button>
  </div>
</template>
