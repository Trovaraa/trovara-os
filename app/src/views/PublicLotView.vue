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
const pendingVerification = ref(false)

const celebrationSymbols = computed(() => {
  const product = lot.value?.productName.toLowerCase() ?? ''

  if (product.includes('plantain') || product.includes('banana')) {
    return ['🍌', '🌿', '🍌', '🌱', '🍌', '🌿', '🍌', '🌱', '🍌', '🌿']
  }
  if (product.includes('coconut')) {
    return ['🥥', '🌴', '🥥', '🌿', '🥥', '🌴', '🥥', '🌱', '🥥', '🌴']
  }
  if (product.includes('egg')) {
    return ['🥚', '🐣', '🥚', '🌿', '🥚', '🐣', '🥚', '🌱', '🥚', '🐣']
  }
  if (product.includes('chicken') || product.includes('poultry') || product.includes('broiler')) {
    return ['🐔', '🌿', '🐔', '🌱', '🐔', '🌿', '🐔', '🌱', '🐔', '🌿']
  }
  if (product.includes('palm') || product.includes('oil')) {
    return ['🌴', '🟠', '🌴', '🌿', '🟠', '🌴', '🟠', '🌱', '🌴', '🟠']
  }

  return ['🌱', '🌿', '✨', '🌾', '🌱', '🌿', '✨', '🌾', '🌱', '🌿']
})

const certificateHref = computed(
  () =>
    `/public/lots/${encodeURIComponent(farmSlug.value)}/${encodeURIComponent(publicToken.value)}/certificate.html`,
)

onMounted(async () => {
  loading.value = true
  error.value = null
  pendingVerification.value = false
  try {
    const data = await api<{ lot: PublicLot; verified: boolean }>(
      `/public/lots/${encodeURIComponent(farmSlug.value)}/${encodeURIComponent(publicToken.value)}`,
    )
    lot.value = data.lot
    verified.value = data.verified
  } catch (e) {
    const message = e instanceof Error ? e.message : t('publicLot.lotNotFound')
    const code = e instanceof Error ? (e as Error & { code?: string }).code : undefined
    if (
      code === 'pending_verification' ||
      /being prepared|pending verification|once the farm confirms/i.test(message)
    ) {
      pendingVerification.value = true
    } else {
      error.value = message
    }
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div
    class="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center overflow-x-hidden p-4 sm:p-6"
  >
    <div class="w-full max-w-md public-lot-stage">
      <p class="text-farm-gold text-xs font-bold tracking-widest uppercase text-center">{{ t('publicLot.brand') }}</p>
      <h1 class="text-xl sm:text-2xl font-black text-center mt-2">{{ t('publicLot.title') }}</h1>

      <div v-if="loading" class="mt-10 text-center text-slate-400">{{ t('publicLot.verifying') }}</div>

      <div
        v-else-if="pendingVerification"
        class="mt-10 bg-slate-900 border border-farm-gold/40 rounded-2xl p-6 text-center space-y-3"
      >
        <p class="text-farm-gold font-bold">{{ t('publicLot.pendingTitle') }}</p>
        <p class="text-sm text-slate-300 leading-relaxed">{{ t('publicLot.pendingBody') }}</p>
        <p class="text-xs text-slate-500 font-mono break-all">{{ publicToken }}</p>
      </div>

      <div v-else-if="error" class="mt-10 bg-slate-900 border border-red-900/50 rounded-2xl p-6 text-center">
        <p class="text-red-300">{{ error }}</p>
        <p class="text-xs text-slate-500 mt-3 font-mono">{{ publicToken }}</p>
      </div>

      <div v-else-if="lot" class="public-lot-reveal-wrap mt-8">
        <div class="party-burst party-burst--left" aria-hidden="true">
          <span
            v-for="(symbol, index) in celebrationSymbols"
            :key="`left-${index}`"
            class="party-particle"
          >{{ symbol }}</span>
        </div>
        <div class="party-burst party-burst--right" aria-hidden="true">
          <span
            v-for="(symbol, index) in celebrationSymbols"
            :key="`right-${index}`"
            class="party-particle"
          >{{ symbol }}</span>
        </div>

        <div class="public-lot-card bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
          <div class="text-center">
          <p class="text-xs text-slate-500 uppercase tracking-wide">{{ t('publicLot.lotCodeLabel') }}</p>
          <p class="lot-code text-2xl sm:text-3xl font-black font-mono text-farm-gold mt-1">
            {{ lot.lotCode }}
          </p>
          <p v-if="verified" class="verified-badge text-xs text-farm-green mt-2 font-bold">
            {{ t('publicLot.verifiedBadge') }}
          </p>
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
              class="inline-flex min-h-11 items-center justify-center text-sm px-5 py-2.5 rounded-lg bg-farm-green text-white font-semibold hover:bg-farm-green/90"
            >
              {{ t('publicLot.downloadCertificate') }}
            </a>
            <p class="text-xs text-slate-500">{{ t('publicLot.shareHint') }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.public-lot-stage {
  perspective: 1200px;
}

.public-lot-reveal-wrap {
  position: relative;
  isolation: isolate;
}

.public-lot-card {
  position: relative;
  z-index: 2;
  transform-origin: center;
  transform-style: preserve-3d;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  will-change: transform, opacity, box-shadow;
  animation: public-lot-reveal 1.75s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.lot-code {
  overflow-wrap: anywhere;
}

.verified-badge {
  animation: verified-badge-celebrate 680ms 1.18s ease-out both;
}

@keyframes public-lot-reveal {
  0% {
    opacity: 0;
    transform: rotateY(-360deg) scale(0.72);
    box-shadow: 0 0 0 rgb(34 197 94 / 0);
  }

  12% {
    opacity: 1;
  }

  68% {
    transform: rotateY(0deg) scale(1);
    box-shadow: 0 0 0 rgb(34 197 94 / 0);
  }

  78% {
    transform: rotateY(0deg) rotate(-1.5deg) scale(1.075);
    box-shadow:
      0 0 0 3px rgb(34 197 94 / 0.22),
      0 0 42px rgb(234 179 8 / 0.28);
  }

  86% {
    transform: rotateY(0deg) rotate(1.25deg) scale(0.985);
  }

  93% {
    transform: rotateY(0deg) rotate(-0.5deg) scale(1.025);
  }

  100% {
    opacity: 1;
    transform: rotateY(0deg) rotate(0) scale(1);
    box-shadow:
      0 0 0 1px rgb(34 197 94 / 0.08),
      0 18px 48px rgb(0 0 0 / 0.28);
  }
}

@keyframes verified-badge-celebrate {
  0% {
    opacity: 0.35;
    text-shadow: 0 0 0 rgb(34 197 94 / 0);
  }

  45% {
    opacity: 1;
    text-shadow: 0 0 18px rgb(34 197 94 / 0.85);
  }

  100% {
    opacity: 1;
    text-shadow: 0 0 5px rgb(34 197 94 / 0.25);
  }
}

.party-burst {
  position: absolute;
  z-index: 3;
  bottom: 12%;
  width: 1px;
  height: 1px;
  pointer-events: none;
}

.party-burst--left {
  left: 4%;
}

.party-burst--right {
  right: 4%;
  transform: scaleX(-1);
}

.party-burst::after {
  content: '';
  position: absolute;
  top: -3px;
  left: -8px;
  width: 0;
  height: 0;
  border-top: 7px solid transparent;
  border-bottom: 7px solid transparent;
  border-left: 18px solid rgb(234 179 8);
  opacity: 0;
  transform: rotate(-45deg) scale(0.5);
  transform-origin: left center;
  animation: party-popper 620ms 1.14s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.party-particle {
  --party-x: 0px;
  --party-y: -80px;
  --party-r: 180deg;
  --party-delay: 0ms;
  position: absolute;
  width: 1.75rem;
  height: 1.75rem;
  font-size: 1.45rem;
  line-height: 1;
  text-align: center;
  filter: drop-shadow(0 2px 3px rgb(0 0 0 / 0.35));
  opacity: 0;
  animation: party-particle-flight 920ms calc(1.16s + var(--party-delay))
    cubic-bezier(0.18, 0.72, 0.28, 1) both;
}

.party-particle:nth-child(3n) {
  font-size: 1.15rem;
}

.party-particle:nth-child(4n) {
  font-size: 1.7rem;
}

.party-particle:nth-child(1) {
  --party-x: 36px;
  --party-y: -118px;
  --party-r: 240deg;
}

.party-particle:nth-child(2) {
  --party-x: 62px;
  --party-y: -92px;
  --party-r: -180deg;
  --party-delay: 35ms;
}

.party-particle:nth-child(3) {
  --party-x: 88px;
  --party-y: -142px;
  --party-r: 320deg;
  --party-delay: 60ms;
}

.party-particle:nth-child(4) {
  --party-x: 118px;
  --party-y: -106px;
  --party-r: -260deg;
  --party-delay: 15ms;
}

.party-particle:nth-child(5) {
  --party-x: 144px;
  --party-y: -162px;
  --party-r: 390deg;
  --party-delay: 75ms;
}

.party-particle:nth-child(6) {
  --party-x: 172px;
  --party-y: -122px;
  --party-r: -340deg;
  --party-delay: 45ms;
}

.party-particle:nth-child(7) {
  --party-x: 78px;
  --party-y: -190px;
  --party-r: 280deg;
  --party-delay: 90ms;
}

.party-particle:nth-child(8) {
  --party-x: 206px;
  --party-y: -176px;
  --party-r: -420deg;
  --party-delay: 110ms;
}

.party-particle:nth-child(9) {
  --party-x: 132px;
  --party-y: -218px;
  --party-r: 360deg;
  --party-delay: 70ms;
}

.party-particle:nth-child(10) {
  --party-x: 226px;
  --party-y: -232px;
  --party-r: -300deg;
  --party-delay: 125ms;
}

@keyframes party-popper {
  0% {
    opacity: 0;
    transform: rotate(-45deg) scale(0.5);
  }

  35% {
    opacity: 1;
    transform: rotate(-45deg) scale(1.18);
  }

  100% {
    opacity: 0;
    transform: rotate(-45deg) scale(0.85);
  }
}

@keyframes party-particle-flight {
  0% {
    opacity: 0;
    transform: translate(0, 0) rotate(0) scale(0.4);
  }

  15% {
    opacity: 1;
  }

  76% {
    opacity: 1;
  }

  100% {
    opacity: 0;
    transform: translate(var(--party-x), var(--party-y)) rotate(var(--party-r)) scale(0.85);
  }
}

@media (max-width: 480px) {
  .public-lot-card {
    animation-duration: 1.55s;
  }

  .party-burst--left {
    left: 7%;
    transform: scale(0.82);
    transform-origin: bottom left;
  }

  .party-burst--right {
    right: 7%;
    transform: scaleX(-1) scale(0.82);
    transform-origin: bottom right;
  }

  .party-particle {
    animation-duration: 760ms;
  }
}

@media (prefers-reduced-motion: reduce) {
  .public-lot-card {
    animation: public-lot-reveal-reduced 720ms ease-out both;
  }

  .verified-badge {
    animation: verified-badge-reduced 780ms 180ms ease-out both;
  }

  .party-burst {
    display: none;
  }

  @keyframes public-lot-reveal-reduced {
    from {
      opacity: 0;
      box-shadow:
        0 0 0 1px rgb(234 179 8 / 0),
        0 0 0 rgb(34 197 94 / 0);
    }

    55% {
      opacity: 1;
      box-shadow:
        0 0 0 3px rgb(234 179 8 / 0.3),
        0 0 34px rgb(34 197 94 / 0.24);
    }

    to {
      opacity: 1;
      box-shadow:
        0 0 0 1px rgb(34 197 94 / 0.08),
        0 12px 36px rgb(0 0 0 / 0.25);
    }
  }

  @keyframes verified-badge-reduced {
    from {
      opacity: 0.45;
      color: rgb(148 163 184);
      text-shadow: 0 0 0 rgb(34 197 94 / 0);
    }

    55% {
      opacity: 1;
      color: rgb(34 197 94);
      text-shadow: 0 0 16px rgb(34 197 94 / 0.7);
    }

    to {
      opacity: 1;
      color: rgb(34 197 94);
      text-shadow: 0 0 4px rgb(34 197 94 / 0.2);
    }
  }
}
</style>
