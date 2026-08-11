<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { installSwUpdate, swUpdateAvailable } from '@/lib/sw-update'

const { t } = useI18n()
</script>

<template>
  <aside
    v-if="swUpdateAvailable"
    class="fixed bottom-5 left-1/2 z-[999] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-3 rounded-xl bg-farm-green px-5 py-3 text-sm font-semibold text-white shadow-2xl"
    role="status"
    aria-live="polite"
  >
    <span>{{ t('swUpdate.available') }}</span>
    <button
      type="button"
      class="rounded-lg bg-white px-3 py-1.5 font-bold text-farm-green focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      @click="installSwUpdate"
    >
      {{ t('swUpdate.action') }}
    </button>
  </aside>
</template>
