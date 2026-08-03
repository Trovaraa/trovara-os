<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

const route = useRoute()
const { t } = useI18n()

const reference = computed(() => {
  const raw = route.query.reference ?? route.query.trxref
  return typeof raw === 'string' ? raw.trim() : ''
})

const status = computed(() => {
  const raw = route.query.status
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
})

const looksFailed = computed(() => {
  return status.value === 'failed' || status.value === 'abandoned' || status.value === 'cancelled'
})
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-6 py-16">
    <div class="max-w-md w-full text-center space-y-4">
      <p class="text-farm-green font-black tracking-[0.2em] text-xs uppercase">
        {{ t('payCallback.brand') }}
      </p>
      <h1 class="text-2xl font-black text-os-fg">
        {{ looksFailed ? t('payCallback.notCompleted') : t('payCallback.thankYou') }}
      </h1>
      <p class="text-slate-400 text-sm leading-relaxed">
        {{ looksFailed ? t('payCallback.failedBody') : t('payCallback.successBody') }}
      </p>
      <p v-if="reference" class="text-xs font-mono text-slate-500 break-all">
        {{ t('payCallback.ref', { reference }) }}
      </p>
    </div>
  </div>
</template>
