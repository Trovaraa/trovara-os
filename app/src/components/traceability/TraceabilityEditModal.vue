<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { TraceabilityLot, TraceabilityPlotOption } from '@/components/traceability/types'

const editProductName = defineModel<string>('editProductName', { required: true })
const editQuantityKg = defineModel<number | ''>('editQuantityKg', { required: true })
const editUnit = defineModel<'kg' | 'crates'>('editUnit', { required: true })
const editPlotId = defineModel<string>('editPlotId', { required: true })
const editPublicNotes = defineModel<string>('editPublicNotes', { required: true })
const editInternalNotes = defineModel<string>('editInternalNotes', { required: true })

defineProps<{
  editing: TraceabilityLot
  plots: TraceabilityPlotOption[]
  canManage: boolean
  editPhoto: string | null
  savingEdit: boolean
  editError: string | null
}>()

const emit = defineEmits<{
  close: []
  save: []
  'photo-change': [e: Event]
}>()

const { t } = useI18n()
</script>

<template>
  <div
    class="fixed inset-0 z-40 bg-black/60 flex items-end sm:items-center justify-center p-4"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-xl p-5 space-y-3">
      <h3 class="text-white font-bold">Update lot · {{ editing.lotCode }}</h3>
      <p v-if="editing.orderReference" class="text-xs text-slate-400 font-mono">
        Order {{ editing.orderReference }}
        <span v-if="editing.orderSource">({{ editing.orderSource }})</span>
      </p>
      <input
        v-model="editProductName"
        type="text"
        required
        class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        placeholder="Product"
      />
      <div class="grid grid-cols-2 gap-3">
        <input
          v-model.number="editQuantityKg"
          type="number"
          min="1"
          step="1"
          required
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          placeholder="Quantity"
        />
        <select
          v-model="editUnit"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="kg">kg</option>
          <option value="crates">crates</option>
        </select>
      </div>
      <select
        v-model="editPlotId"
        class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
      >
        <option value="">Plot / block (optional)</option>
        <option v-for="p in plots" :key="p.id" :value="p.id">
          {{ p.zoneName ? `${p.zoneName} / ` : '' }}{{ p.name }}
        </option>
      </select>
      <textarea
        v-model="editPublicNotes"
        rows="2"
        maxlength="1000"
        :placeholder="t('trace.publicNotesPlaceholder')"
        class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white resize-none"
      />
      <textarea
        v-if="canManage"
        v-model="editInternalNotes"
        rows="2"
        maxlength="1000"
        :placeholder="t('trace.internalNotesPlaceholder')"
        class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white resize-none"
      />
      <label class="block">
        <span class="text-xs text-slate-400">{{ t('trace.photoEvidence') }}</span>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          class="mt-1 w-full text-xs text-slate-400"
          @change="emit('photo-change', $event)"
        />
        <p v-if="editing.photoUrl && !editPhoto" class="text-[10px] text-slate-500 mt-1">Photo already attached</p>
      </label>
      <p v-if="editError" class="text-xs text-red-400">{{ editError }}</p>
      <div class="flex gap-2 justify-end">
        <button
          type="button"
          class="text-sm px-4 py-2 rounded-lg bg-slate-800 text-slate-300"
          :disabled="savingEdit"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button
          type="button"
          class="text-sm px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green font-semibold disabled:opacity-50"
          :disabled="savingEdit"
          @click="emit('save')"
        >
          {{ savingEdit ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </div>
</template>
