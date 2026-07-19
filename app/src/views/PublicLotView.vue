<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'

const { t } = useI18n()

// Only public fields - the /public endpoint intentionally never returns phone or full legal name.
type PublicLot = {
  lotCode: string
  productName: string
  quantityKg: number
  unit?: string
  harvestedAt: string
  plotName?: string | null
  cropType?: string | null
  publicNotes?: string | null
  preparedFor?: string | null
  orderReference?: string | null
  farm: { slug?: string | null; name: string; location?: string | null }
}

const route = useRoute()
const farmSlug = computed(() => String(route.params.farmSlug ?? ''))
const publicToken = computed(() => String(route.params.lotCode ?? ''))

const lot = ref<PublicLot | null>(null)
const verified = ref(false)
const loading = ref(true)
const error = ref<string | null>(null)

const certificateHref = computed(
  () =>
    `/public/lots/${encodeURIComponent(farmSlug.value)}/${encodeURIComponent(publicToken.value)}/certificate.html`,
)

onMounted(async () => {
  loading.value = true
  error.value = null
  try {
    const data = await api<{ lot: PublicLot; verified: boolean }>(
      `/public/lots/${encodeURIComponent(farmSlug.value)}/${encodeURIComponent(publicToken.value)}`,
    )
    lot.value = data.lot
    verified.value = data.verified
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('publicLot.lotNotFound')
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6">
    <div class="w-full max-w-md">
      <p class="text-farm-gold text-xs font-bold tracking-widest uppercase text-center">{{ t('publicLot.brand') }}</p>
      <h1 class="text-2xl font-black text-center mt-2">{{ t('publicLot.title') }}</h1>

      <div v-if="loading" class="mt-10 text-center text-slate-400">{{ t('publicLot.verifying') }}</div>

      <div v-else-if="error" class="mt-10 bg-slate-900 border border-red-900/50 rounded-2xl p-6 text-center">
        <p class="text-red-300">{{ error }}</p>
        <p class="text-xs text-slate-500 mt-3 font-mono">{{ publicToken }}</p>
      </div>

      <div v-else-if="lot" class="mt-8 bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
        <div class="text-center">
          <p class="text-xs text-slate-500 uppercase tracking-wide">{{ t('publicLot.lotCodeLabel') }}</p>
          <p class="text-3xl font-black font-mono text-farm-gold mt-1">{{ lot.lotCode }}</p>
          <p v-if="verified" class="text-xs text-farm-green mt-2 font-bold">{{ t('publicLot.verifiedBadge') }}</p>
        </div>

        <p class="text-sm text-slate-400 leading-relaxed text-center">{{ t('publicLot.why') }}</p>

        <div class="space-y-3 text-sm">
          <div v-if="lot.preparedFor" class="flex justify-between gap-4">
            <span class="text-slate-500">{{ t('publicLot.preparedFor') }}</span>
            <span class="text-white font-medium text-right">{{ lot.preparedFor }}</span>
          </div>
          <div v-if="lot.orderReference" class="flex justify-between gap-4">
            <span class="text-slate-500">{{ t('publicLot.order') }}</span>
            <span class="text-slate-300 font-mono text-right">{{ lot.orderReference }}</span>
          </div>
          <div class="flex justify-between gap-4">
            <span class="text-slate-500">{{ t('publicLot.product') }}</span>
            <span class="text-white font-medium text-right">{{ lot.productName }}</span>
          </div>
          <div class="flex justify-between gap-4">
            <span class="text-slate-500">{{ t('publicLot.quantity') }}</span>
            <span class="text-white font-mono">{{ lot.quantityKg }} {{ lot.unit === 'crates' ? 'crates' : 'kg' }}</span>
          </div>
          <div v-if="lot.plotName" class="flex justify-between gap-4">
            <span class="text-slate-500">{{ t('publicLot.plot') }}</span>
            <span class="text-slate-300">{{ lot.plotName }}</span>
          </div>
          <div v-if="lot.cropType" class="flex justify-between gap-4">
            <span class="text-slate-500">{{ t('publicLot.crop') }}</span>
            <span class="text-slate-300 capitalize">{{ lot.cropType }}</span>
          </div>
          <div class="flex justify-between gap-4">
            <span class="text-slate-500">{{ t('publicLot.harvested') }}</span>
            <span class="text-slate-300">{{ new Date(lot.harvestedAt).toLocaleDateString() }}</span>
          </div>
          <div class="flex justify-between gap-4">
            <span class="text-slate-500">{{ t('publicLot.farm') }}</span>
            <span class="text-slate-300 text-right">{{ lot.farm.name }}</span>
          </div>
          <div v-if="lot.farm.location" class="flex justify-between gap-4">
            <span class="text-slate-500">{{ t('publicLot.location') }}</span>
            <span class="text-slate-300 text-right">{{ lot.farm.location }}</span>
          </div>
          <div v-if="lot.publicNotes" class="pt-1">
            <p class="text-slate-500 mb-1">{{ t('publicLot.publicNotes') }}</p>
            <p class="text-slate-300 leading-relaxed">{{ lot.publicNotes }}</p>
          </div>
        </div>

        <div class="pt-4 border-t border-slate-800 text-center space-y-3">
          <a
            :href="certificateHref"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-block text-sm px-5 py-2.5 rounded-lg bg-farm-green text-white font-semibold hover:bg-farm-green/90"
          >
            {{ t('publicLot.downloadCertificate') }}
          </a>
          <p class="text-xs text-slate-500">{{ t('publicLot.shareHint') }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
