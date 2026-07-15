<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/lib/api'

// Only public fields - the /public endpoint intentionally never returns internal notes.
type PublicLot = {
  lotCode: string
  productName: string
  quantityKg: number
  harvestedAt: string
  plotName?: string | null
  cropType?: string | null
  publicNotes?: string | null
  farm: { slug?: string | null; name: string; location?: string | null }
}

const route = useRoute()
const farmSlug = computed(() => String(route.params.farmSlug ?? ''))
const lotCode = computed(() => String(route.params.lotCode ?? ''))

const lot = ref<PublicLot | null>(null)
const verified = ref(false)
const loading = ref(true)
const error = ref<string | null>(null)

const publicUrl = computed(() =>
  `${window.location.origin}/lot/${farmSlug.value}/${lotCode.value}`,
)

onMounted(async () => {
  loading.value = true
  error.value = null
  try {
    const data = await api<{ lot: PublicLot; verified: boolean }>(
      `/public/lots/${encodeURIComponent(farmSlug.value)}/${encodeURIComponent(lotCode.value)}`,
    )
    lot.value = data.lot
    verified.value = data.verified
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Lot not found'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6">
    <div class="w-full max-w-md">
      <p class="text-farm-gold text-xs font-bold tracking-widest uppercase text-center">Trovara OS</p>
      <h1 class="text-2xl font-black text-center mt-2">Harvest Lot Verification</h1>

      <div v-if="loading" class="mt-10 text-center text-slate-400">Verifying lot…</div>

      <div v-else-if="error" class="mt-10 bg-slate-900 border border-red-900/50 rounded-2xl p-6 text-center">
        <p class="text-red-300">{{ error }}</p>
        <p class="text-xs text-slate-500 mt-3 font-mono">{{ lotCode }}</p>
      </div>

      <div v-else-if="lot" class="mt-10 bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
        <div class="text-center">
          <p class="text-xs text-slate-500 uppercase tracking-wide">Lot code</p>
          <p class="text-3xl font-black font-mono text-farm-gold mt-1">{{ lot.lotCode }}</p>
          <p v-if="verified" class="text-xs text-farm-green mt-2 font-bold">✓ Verified harvest lot</p>
        </div>

        <div class="space-y-3 text-sm">
          <div class="flex justify-between gap-4">
            <span class="text-slate-500">Product</span>
            <span class="text-white font-medium text-right">{{ lot.productName }}</span>
          </div>
          <div class="flex justify-between gap-4">
            <span class="text-slate-500">Quantity</span>
            <span class="text-white font-mono">{{ lot.quantityKg }} kg</span>
          </div>
          <div v-if="lot.plotName" class="flex justify-between gap-4">
            <span class="text-slate-500">Plot</span>
            <span class="text-slate-300">{{ lot.plotName }}</span>
          </div>
          <div v-if="lot.cropType" class="flex justify-between gap-4">
            <span class="text-slate-500">Crop</span>
            <span class="text-slate-300 capitalize">{{ lot.cropType }}</span>
          </div>
          <div class="flex justify-between gap-4">
            <span class="text-slate-500">Harvested</span>
            <span class="text-slate-300">{{ new Date(lot.harvestedAt).toLocaleDateString() }}</span>
          </div>
          <div class="flex justify-between gap-4">
            <span class="text-slate-500">Farm</span>
            <span class="text-slate-300 text-right">{{ lot.farm.name }}</span>
          </div>
          <div v-if="lot.farm.location" class="flex justify-between gap-4">
            <span class="text-slate-500">Location</span>
            <span class="text-slate-300 text-right">{{ lot.farm.location }}</span>
          </div>
          <div v-if="lot.publicNotes" class="pt-1">
            <p class="text-slate-500 mb-1">Public notes</p>
            <p class="text-slate-300 leading-relaxed">{{ lot.publicNotes }}</p>
          </div>
        </div>

        <div class="pt-4 border-t border-slate-800 text-center">
          <p class="text-xs text-slate-500">
            Scan the QR code on the harvest label or share this link:
          </p>
          <p class="text-xs font-mono text-farm-green mt-2 break-all">{{ publicUrl }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
