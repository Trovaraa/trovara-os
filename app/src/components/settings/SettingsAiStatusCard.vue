<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  configured: boolean | undefined
  hint?: string
}>()

const { t } = useI18n()
</script>

<template>
  <div class="bg-slate-900 border border-slate-800 rounded-xl p-5">
    <h3 class="font-bold text-white text-sm">{{ t('settings.aiIntegration') }}</h3>
    <p class="text-xs mt-2">
      <span
        class="font-bold px-2 py-0.5 rounded-full"
        :class="configured ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-700 text-slate-400'"
      >
        {{ configured ? t('settings.configured') : t('settings.notConfigured') }}
      </span>
    </p>
    <p v-if="hint" class="text-xs text-slate-500 mt-2">{{ hint }}</p>
  </div>
</template>
