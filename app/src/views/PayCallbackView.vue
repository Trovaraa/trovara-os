<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()

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
      <p class="text-farm-green font-black tracking-[0.2em] text-xs uppercase">Trovara Farm</p>
      <h1 class="text-2xl font-black text-os-fg">
        {{ looksFailed ? 'Payment not completed' : 'Thank you' }}
      </h1>
      <p class="text-slate-400 text-sm leading-relaxed">
        <template v-if="looksFailed">
          Your payment did not go through. You can open the pay link again from the order chat, or
          message the farm for help.
        </template>
        <template v-else>
          If you paid successfully, we will confirm your order shortly. You can close this page and
          return to Telegram or WhatsApp to track your order.
        </template>
      </p>
      <p v-if="reference" class="text-xs font-mono text-slate-500 break-all">
        Ref: {{ reference }}
      </p>
    </div>
  </div>
</template>
