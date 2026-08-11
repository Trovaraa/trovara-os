<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { TraceabilityLot } from '@/components/traceability/types'
import { resolveApiUrl } from '@/lib/api'

defineProps<{
  lots: TraceabilityLot[]
  canPrintQr: boolean
  canManage: boolean
  isOwner: boolean
  verifyingId: string | null
  loadingQrFor: string | null
  qrByLotId: Record<string, { imgUrl: string; url: string }>
  needsPack: (lot: TraceabilityLot) => boolean
  qtyLabel: (lot: Pick<TraceabilityLot, 'quantityKg' | 'unit'>) => string
  statusMeta: (status: string) => { label: string; cls: string }
  publicLotUrl: (lot: Pick<TraceabilityLot, 'farmSlug' | 'lotCode' | 'publicToken'>) => string
}>()

const emit = defineEmits<{
  edit: [lot: TraceabilityLot]
  verify: [lot: TraceabilityLot, status: 'verified' | 'rejected']
  timeline: [lot: TraceabilityLot]
  'fetch-qr': [lotId: string]
}>()

const { t } = useI18n()

function plotLabel(lot: TraceabilityLot) {
  if (lot.zoneName && lot.plotName) return `${lot.zoneName} / ${lot.plotName}`
  return lot.plotName ?? '—'
}
</script>

<template>
  <div class="mt-8 space-y-4">
    <article
      v-for="lot in lots"
      :key="lot.id"
      class="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5"
      :class="needsPack(lot) ? 'ring-1 ring-inset ring-amber-500/30' : ''"
    >
      <!-- Header: identity + status -->
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="font-mono text-sm font-bold text-farm-gold break-all">{{ lot.lotCode }}</p>
          <h3 class="mt-1 text-base font-bold text-white leading-snug">{{ lot.productName }}</h3>
          <p class="mt-1 text-sm text-slate-400">
            <span class="font-mono text-slate-300">{{ qtyLabel(lot) }}</span>
            <span class="text-slate-600"> · </span>
            {{ plotLabel(lot) }}
            <span class="text-slate-600"> · </span>
            {{ new Date(lot.harvestedAt).toLocaleDateString() }}
          </p>
          <p v-if="lot.orderReference" class="mt-1 text-xs text-slate-500">
            Order
            <span class="font-mono text-slate-400">{{ lot.orderReference }}</span>
            <span v-if="lot.orderSource"> · {{ lot.orderSource }}</span>
          </p>
        </div>
        <div class="text-right shrink-0">
          <span
            class="inline-block text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap"
            :class="statusMeta(lot.verificationStatus).cls"
          >
            {{ statusMeta(lot.verificationStatus).label }}
          </span>
          <p v-if="needsPack(lot)" class="mt-1.5 text-[11px] font-semibold text-amber-300">
            Needs pack details
          </p>
          <p v-if="lot.reportedByName" class="mt-1 text-[11px] text-slate-500">
            {{ t('trace.by') }} {{ lot.reportedByName }}
          </p>
        </div>
      </div>

      <!-- Notes + public link -->
      <div class="mt-4 grid gap-3 sm:grid-cols-2 text-xs">
        <div class="rounded-xl bg-slate-800/50 border border-slate-800 px-3 py-2.5 space-y-1">
          <p class="text-slate-500">
            <span class="font-semibold">{{ t('trace.publicLabel') }}</span>
            <span class="text-slate-300"> {{ lot.publicNotes || '—' }}</span>
          </p>
          <p class="text-slate-500">
            <span class="font-semibold">{{ t('trace.internalLabel') }}</span>
            <span class="text-slate-300"> {{ lot.internalNotes || '—' }}</span>
          </p>
        </div>
        <div class="rounded-xl bg-slate-800/50 border border-slate-800 px-3 py-2.5 flex flex-col justify-center gap-2">
          <template v-if="lot.verificationStatus === 'verified'">
            <a
              :href="publicLotUrl(lot)"
              target="_blank"
              rel="noopener noreferrer"
              class="text-sm font-semibold text-farm-green hover:underline"
            >
              {{ t('trace.thPublicLink') }} →
            </a>
            <p class="font-mono text-[10px] text-slate-500 break-all line-clamp-2">
              {{ publicLotUrl(lot) }}
            </p>
          </template>
          <p v-else class="text-slate-500">{{ t('trace.notPublicYet') }}</p>
        </div>
      </div>

      <!-- QR preview (optional) -->
      <div v-if="canPrintQr && qrByLotId[lot.id]" class="mt-3 flex items-start gap-3">
        <img
          :src="qrByLotId[lot.id].imgUrl"
          :alt="t('trace.lotQrAlt')"
          class="rounded-lg border border-slate-800 bg-white p-2 h-28 w-28 shrink-0"
        />
        <a
          :href="qrByLotId[lot.id].url"
          target="_blank"
          rel="noopener noreferrer"
          class="text-[11px] text-farm-green hover:underline break-all"
        >
          {{ qrByLotId[lot.id].url }}
        </a>
      </div>

      <!-- Actions: primary row then secondary -->
      <div class="mt-4 pt-4 border-t border-slate-800 flex flex-col gap-2">
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green font-semibold hover:bg-farm-green/30"
            @click="emit('edit', lot)"
          >
            {{ needsPack(lot) ? 'Complete pack' : 'Update lot' }}
          </button>
          <template v-if="canManage && lot.verificationStatus === 'reported'">
            <button
              type="button"
              :disabled="verifyingId === lot.id"
              class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green font-semibold hover:bg-farm-green/30 disabled:opacity-50"
              @click="emit('verify', lot, 'verified')"
            >
              {{ t('trace.verify') }}
            </button>
            <button
              type="button"
              :disabled="verifyingId === lot.id"
              class="text-xs px-3 py-1.5 rounded-lg bg-red-900/40 text-red-300 font-semibold hover:bg-red-900/60 disabled:opacity-50"
              @click="emit('verify', lot, 'rejected')"
            >
              {{ t('trace.reject') }}
            </button>
          </template>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            v-if="canManage"
            type="button"
            class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
            @click="emit('timeline', lot)"
          >
            {{ t('trace.timeline') }}
          </button>
          <a
            v-if="canPrintQr"
            :href="resolveApiUrl(`/api/traceability/${lot.id}/label.html?autoprint=1`)"
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            {{ t('trace.printQr') }}
          </a>
          <button
            v-if="canPrintQr"
            type="button"
            class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
            :disabled="loadingQrFor === lot.id"
            @click="emit('fetch-qr', lot.id)"
          >
            {{ loadingQrFor === lot.id ? t('trace.loadingShort') : qrByLotId[lot.id] ? t('trace.refreshQr') : t('trace.showQr') }}
          </button>
          <a
            v-if="isOwner"
            :href="resolveApiUrl(`/api/traceability/${lot.id}/certificate.html`)"
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            {{ t('trace.downloadCert') }}
          </a>
        </div>
      </div>
    </article>

    <p v-if="!lots.length" class="text-slate-500 text-sm">{{ t('trace.noLots') }}</p>
  </div>
</template>
