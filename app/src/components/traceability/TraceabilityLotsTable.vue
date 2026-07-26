<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { TraceabilityLot } from '@/components/traceability/types'

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
</script>

<template>
  <div class="mt-8 overflow-x-auto">
    <table class="w-full text-sm">
      <thead>
        <tr class="text-left text-slate-500 border-b border-slate-800">
          <th class="pb-3 font-semibold">{{ t('trace.lotCode') }}</th>
          <th class="pb-3 font-semibold">Order</th>
          <th class="pb-3 font-semibold">{{ t('trace.thProduct') }}</th>
          <th class="pb-3 font-semibold">{{ t('trace.thPlot') }}</th>
          <th class="pb-3 font-semibold">{{ t('trace.thQuantity') }}</th>
          <th class="pb-3 font-semibold">{{ t('trace.thHarvested') }}</th>
          <th class="pb-3 font-semibold">{{ t('trace.thStatus') }}</th>
          <th class="pb-3 font-semibold">{{ t('trace.thPublicLink') }}</th>
          <th v-if="canPrintQr" class="pb-3 font-semibold">{{ t('trace.thQr') }}</th>
          <th class="pb-3 font-semibold">{{ t('trace.thNotes') }}</th>
          <th class="pb-3 font-semibold">{{ t('trace.thActions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="lot in lots"
          :key="lot.id"
          class="border-b border-slate-800/50"
          :class="needsPack(lot) ? 'bg-amber-500/5' : ''"
        >
          <td class="py-4 font-mono font-bold text-farm-gold">{{ lot.lotCode }}</td>
          <td class="py-4 text-xs text-slate-400">
            <span v-if="lot.orderReference" class="font-mono text-slate-300">{{ lot.orderReference }}</span>
            <span v-else>-</span>
            <span v-if="lot.orderSource" class="block text-[10px] text-slate-500">{{ lot.orderSource }}</span>
          </td>
          <td class="py-4 text-white">{{ lot.productName }}</td>
          <td class="py-4 text-slate-400">
            <span v-if="lot.zoneName">{{ lot.zoneName }} / </span>{{ lot.plotName ?? '-' }}
          </td>
          <td class="py-4 font-mono text-slate-300">{{ qtyLabel(lot) }}</td>
          <td class="py-4 text-slate-400">
            {{ new Date(lot.harvestedAt).toLocaleDateString() }}
          </td>
          <td class="py-4">
            <span
              class="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
              :class="statusMeta(lot.verificationStatus).cls"
            >
              {{ statusMeta(lot.verificationStatus).label }}
            </span>
            <p v-if="needsPack(lot)" class="text-[10px] text-amber-300 mt-1">Needs pack details</p>
            <p v-if="lot.reportedByName" class="text-[10px] text-slate-500 mt-1">
              {{ t('trace.by') }} {{ lot.reportedByName }}
            </p>
          </td>
          <td class="py-4">
            <a
              v-if="lot.verificationStatus === 'verified'"
              :href="publicLotUrl(lot)"
              target="_blank"
              rel="noopener noreferrer"
              class="text-xs font-mono text-farm-green hover:underline break-all"
            >
              {{ publicLotUrl(lot) }}
            </a>
            <span v-else class="text-xs text-slate-600">{{ t('trace.notPublicYet') }}</span>
          </td>
          <td v-if="canPrintQr" class="py-4">
            <div class="flex flex-col gap-2 items-start">
              <a
                :href="`/api/traceability/${lot.id}/label.html?autoprint=1`"
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green font-semibold hover:bg-farm-green/30"
              >
                {{ t('trace.printQr') }}
              </a>
              <button
                type="button"
                class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700"
                :disabled="loadingQrFor === lot.id"
                @click="emit('fetch-qr', lot.id)"
              >
                {{ loadingQrFor === lot.id ? t('trace.loadingShort') : qrByLotId[lot.id] ? t('trace.refreshQr') : t('trace.showQr') }}
              </button>
            </div>
            <div v-if="qrByLotId[lot.id]" class="mt-2 space-y-1">
              <img
                :src="qrByLotId[lot.id].imgUrl"
                :alt="t('trace.lotQrAlt')"
                class="rounded border border-slate-800 bg-white p-2 h-32 w-32"
              />
              <a
                :href="qrByLotId[lot.id].url"
                target="_blank"
                rel="noopener noreferrer"
                class="block text-[10px] text-farm-green hover:underline break-all"
              >
                {{ qrByLotId[lot.id].url }}
              </a>
            </div>
          </td>
          <td class="py-4 text-xs text-slate-400">
            <p><span class="text-slate-500">{{ t('trace.publicLabel') }}</span> {{ lot.publicNotes || '-' }}</p>
            <p class="mt-1"><span class="text-slate-500">{{ t('trace.internalLabel') }}</span> {{ lot.internalNotes || '-' }}</p>
          </td>
          <td class="py-4">
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
                  class="text-xs px-3 py-1.5 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60 disabled:opacity-50"
                  @click="emit('verify', lot, 'rejected')"
                >
                  {{ t('trace.reject') }}
                </button>
              </template>
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
                :href="`/api/traceability/${lot.id}/label.html?autoprint=1`"
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30"
              >
                {{ t('trace.printQr') }}
              </a>
              <a
                v-if="isOwner"
                :href="`/api/traceability/${lot.id}/certificate.html`"
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30"
              >
                {{ t('trace.downloadCert') }}
              </a>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="!lots.length" class="text-slate-500 text-sm mt-4">{{ t('trace.noLots') }}</p>
  </div>
</template>
