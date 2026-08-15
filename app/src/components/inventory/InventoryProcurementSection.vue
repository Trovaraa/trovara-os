<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import CollapsibleSection from '@/components/CollapsibleSection.vue'
import type {
  PoDraftLine,
  ProcurementItem,
  PurchaseOrder,
  Supplier,
} from '@/composables/useInventoryProcurement'

const newSupplierName = defineModel<string>('newSupplierName', { required: true })
const poSupplierId = defineModel<string>('poSupplierId', { required: true })
const poExpectedAt = defineModel<string>('poExpectedAt', { required: true })
const poNotes = defineModel<string>('poNotes', { required: true })
const poLines = defineModel<PoDraftLine[]>('poLines', { required: true })
const receiveQuantities = defineModel<Record<string, number | ''>>('receiveQuantities', {
  required: true,
})

defineProps<{
  isOwner: boolean
  items: ProcurementItem[]
  suppliers: Supplier[]
  purchaseOrders: PurchaseOrder[]
  selectedPurchaseOrder: PurchaseOrder | null
  supplierSaving: boolean
  poSaving: boolean
  poActionId: string | null
  poMessage: string | null
}>()

const emit = defineEmits<{
  'create-supplier': []
  'add-po-line': []
  'create-purchase-order': []
  'open-purchase-order': [id: string]
  'purchase-order-action': [id: string, action: 'approve' | 'send' | 'cancel']
  'receive-purchase-order': []
}>()

const { t } = useI18n()
</script>

<template>
  <CollapsibleSection
    class="mt-8"
    :title="t('inventory.procurement')"
    :description="t('inventory.procurementDesc')"
    :default-open="false"
    content-class="space-y-5 p-4 sm:p-5"
    test-id="inventory-procurement-section"
  >
    <form class="flex flex-col sm:flex-row gap-2" @submit.prevent="emit('create-supplier')">
      <input
        v-model="newSupplierName"
        :aria-label="t('inventory.supplierName')"
        required
        maxlength="200"
        :placeholder="t('inventory.supplierName')"
        class="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
      />
      <button
        type="submit"
        :disabled="supplierSaving || !newSupplierName.trim()"
        class="text-xs font-bold px-4 py-2 rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-50"
      >
        {{ supplierSaving ? t('inventory.saving') : t('inventory.addSupplier') }}
      </button>
    </form>

    <form
      v-if="suppliers.some((supplier) => supplier.active)"
      class="border-t border-slate-800 pt-5 space-y-3"
      @submit.prevent="emit('create-purchase-order')"
    >
      <h4 class="text-sm font-semibold text-white">{{ t('inventory.draftPo') }}</h4>
      <div class="grid sm:grid-cols-3 gap-3">
        <select
          v-model="poSupplierId"
          :aria-label="t('inventory.chooseSupplier')"
          required
          class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="" disabled>{{ t('inventory.chooseSupplier') }}</option>
          <option
            v-for="supplier in suppliers.filter((candidate) => candidate.active)"
            :key="supplier.id"
            :value="supplier.id"
          >
            {{ supplier.name }}
          </option>
        </select>
        <input
          v-model="poExpectedAt"
          aria-label="Expected delivery date"
          type="datetime-local"
          class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <input
          v-model="poNotes"
          :aria-label="t('inventory.poNotes')"
          maxlength="2000"
          :placeholder="t('inventory.poNotes')"
          class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
      </div>
      <div class="space-y-2">
        <div
          v-for="(line, index) in poLines"
          :key="index"
          class="grid sm:grid-cols-[1fr_110px_150px] gap-2"
        >
          <select
            v-model="line.itemId"
            :aria-label="`${t('inventory.chooseItem')} ${index + 1}`"
            required
            class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="" disabled>{{ t('inventory.chooseItem') }}</option>
            <option v-for="item in items" :key="item.id" :value="item.id">
              {{ item.name }} ({{ item.unit }})
            </option>
          </select>
          <input
            v-model.number="line.quantityOrdered"
            type="number"
            min="1"
            step="1"
            :aria-label="t('inventory.orderQty')"
            class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <input
            v-model.number="line.unitCostMinor"
            :aria-label="t('inventory.unitCostMinor')"
            type="number"
            min="0"
            step="1"
            :placeholder="t('inventory.unitCostMinor')"
            class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
        </div>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300"
          @click="emit('add-po-line')"
        >
          {{ t('inventory.addLine') }}
        </button>
        <button
          type="submit"
          :disabled="poSaving || !poSupplierId || !poLines.some((line) => line.itemId)"
          class="text-xs font-bold px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green disabled:opacity-50"
        >
          {{ poSaving ? t('inventory.saving') : t('inventory.saveDraftPo') }}
        </button>
      </div>
    </form>

    <div class="border-t border-slate-800 pt-5">
      <h4 class="text-sm font-semibold text-white mb-3">{{ t('inventory.purchaseOrders') }}</h4>
      <p v-if="!purchaseOrders.length" class="text-xs text-slate-500">
        {{ t('inventory.noPurchaseOrders') }}
      </p>
      <div v-else class="grid lg:grid-cols-2 gap-3">
        <button
          v-for="order in purchaseOrders"
          :key="order.id"
          type="button"
          class="text-left rounded-lg border border-slate-800 bg-slate-950/60 p-3 hover:border-slate-700"
          @click="emit('open-purchase-order', order.id)"
        >
          <div class="flex justify-between gap-3">
            <span class="text-sm font-semibold text-white">{{ order.supplierName }}</span>
            <span class="text-[11px] uppercase text-farm-green">{{ order.status.replace('_', ' ') }}</span>
          </div>
          <p class="text-xs text-slate-500 mt-1">{{ new Date(order.createdAt).toLocaleDateString() }}</p>
        </button>
      </div>
    </div>

    <div
      v-if="selectedPurchaseOrder"
      class="border-t border-slate-800 pt-5 space-y-3"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 class="text-sm font-semibold text-white">{{ selectedPurchaseOrder.supplierName }}</h4>
          <p class="text-xs text-slate-500 uppercase">{{ selectedPurchaseOrder.status.replace('_', ' ') }}</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            v-if="isOwner && selectedPurchaseOrder.status === 'draft'"
            type="button"
            :disabled="poActionId === selectedPurchaseOrder.id"
            class="text-xs px-3 py-1.5 rounded bg-farm-green/20 text-farm-green"
            @click="emit('purchase-order-action', selectedPurchaseOrder.id, 'approve')"
          >
            {{ t('inventory.approvePo') }}
          </button>
          <button
            v-if="selectedPurchaseOrder.status === 'approved'"
            type="button"
            :disabled="poActionId === selectedPurchaseOrder.id"
            class="text-xs px-3 py-1.5 rounded bg-slate-800 text-slate-300"
            @click="emit('purchase-order-action', selectedPurchaseOrder.id, 'send')"
          >
            {{ t('inventory.markSent') }}
          </button>
          <button
            v-if="isOwner && ['draft', 'approved', 'sent'].includes(selectedPurchaseOrder.status)"
            type="button"
            :disabled="poActionId === selectedPurchaseOrder.id"
            class="text-xs px-3 py-1.5 rounded bg-red-900/40 text-red-300"
            @click="emit('purchase-order-action', selectedPurchaseOrder.id, 'cancel')"
          >
            {{ t('inventory.cancelPo') }}
          </button>
        </div>
      </div>
      <div
        v-for="line in selectedPurchaseOrder.lines"
        :key="line.id"
        class="grid grid-cols-[1fr_auto] gap-3 items-center rounded-lg bg-slate-950 border border-slate-800 p-3"
      >
        <div>
          <p class="text-sm text-white">{{ line.itemName }}</p>
          <p class="text-xs text-slate-500">
            {{ line.quantityReceived }} / {{ line.quantityOrdered }} {{ line.unit }}
          </p>
        </div>
        <input
          v-if="['approved', 'sent', 'partially_received'].includes(selectedPurchaseOrder.status) && line.quantityReceived < line.quantityOrdered"
          v-model.number="receiveQuantities[line.id]"
          type="number"
          min="1"
          :max="line.quantityOrdered - line.quantityReceived"
          step="1"
          :placeholder="t('inventory.receiveQty')"
          class="w-28 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
      </div>
      <button
        v-if="['approved', 'sent', 'partially_received'].includes(selectedPurchaseOrder.status)"
        type="button"
        :disabled="poActionId === selectedPurchaseOrder.id || !Object.values(receiveQuantities).some((value) => Number(value) > 0)"
        class="text-xs font-bold px-3 py-2 rounded-lg bg-farm-green/20 text-farm-green disabled:opacity-50"
        @click="emit('receive-purchase-order')"
      >
        {{ t('inventory.postReceipt') }}
      </button>
    </div>
    <p v-if="poMessage" class="text-xs text-slate-400">{{ poMessage }}</p>
  </CollapsibleSection>
</template>
