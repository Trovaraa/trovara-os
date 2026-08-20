<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import CollapsibleSection from '@/components/CollapsibleSection.vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const auth = useAuthStore()
const canRemove = computed(() => auth.hasPermission('products.delete'))

type Product = {
  id: string
  sku: string
  name: string
  unit: string
  priceKobo: number
  currency: string
  description?: string | null
  category: string
  provenance: 'trovara_grown' | 'trovara_sourced'
  familyBasketQuantity: number
  active: boolean
  sortOrder: number
  inventoryItemId?: string | null
  inventorySku?: string | null
  inventoryQuantity?: number | null
  inventoryUnit?: string | null
}

type InventoryOption = {
  id: string
  sku: string
  name: string
  quantity: number
  unit: string
  productId?: string | null
}

type DeliverySlot = {
  id: string
  label: string
  dayOfWeek: number
  startTime: string
  endTime: string
  cutoffHours: number
  active: boolean
  sortOrder: number
}

const UNIT_OPTIONS = ['kg', 'tonne', 'crate', 'tray', 'bag', 'bunch', 'piece', 'pack', 'bird', 'litre', 'unit']

const products = ref<Product[]>([])
const inventoryOptions = ref<InventoryOption[]>([])
const deliverySlots = ref<DeliverySlot[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

const newName = ref('')
const newSku = ref('')
const newUnit = ref('unit')
const newPriceNaira = ref<number | ''>('')
const newProvenance = ref<'trovara_grown' | 'trovara_sourced'>('trovara_grown')
const newCategory = ref('fresh_from_trovara')
const newFamilyBasketQuantity = ref(0)
const creating = ref(false)

const editing = ref<Product | null>(null)
const editName = ref('')
const editSku = ref('')
const editUnit = ref('unit')
const editPriceNaira = ref<number | ''>('')
const editActive = ref(true)
const editProvenance = ref<'trovara_grown' | 'trovara_sourced'>('trovara_grown')
const editCategory = ref('fresh_from_trovara')
const editFamilyBasketQuantity = ref(0)
const editInventoryItemId = ref('')
const savingEdit = ref(false)
const newDelivery = reactive({
  label: '',
  dayOfWeek: 6,
  startTime: '09:00',
  endTime: '13:00',
  cutoffHours: 24,
})
const savingDelivery = ref(false)

function nairaToKobo(naira: number | ''): number {
  if (naira === '' || Number.isNaN(Number(naira))) return 0
  return Math.round(Number(naira) * 100)
}

function priceLabel(p: Product): string {
  if (p.priceKobo <= 0) return t('products.priceOnRequest')
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: p.currency }).format(
    p.priceKobo / 100,
  )
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const [productData, inventoryData, deliveryData] = await Promise.all([
      api<{ products: Product[] }>('/api/products'),
      api<{ items: InventoryOption[] }>('/api/inventory'),
      api<{ deliverySlots: DeliverySlot[] }>('/api/products/delivery-slots'),
    ])
    products.value = productData.products
    inventoryOptions.value = inventoryData.items ?? []
    deliverySlots.value = deliveryData.deliverySlots ?? []
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('products.loadFailed')
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function createProduct() {
  if (!newName.value.trim()) return
  creating.value = true
  error.value = null
  try {
    await api('/api/products', {
      method: 'POST',
      body: JSON.stringify({
        sku: newSku.value.trim().toUpperCase(),
        name: newName.value.trim(),
        unit: newUnit.value.trim() || 'unit',
        priceKobo: nairaToKobo(newPriceNaira.value),
        provenance: newProvenance.value,
        category: newCategory.value,
        familyBasketQuantity: newFamilyBasketQuantity.value,
        sortOrder: products.value.length + 1,
      }),
    })
    newName.value = ''
    newSku.value = ''
    newUnit.value = 'unit'
    newPriceNaira.value = ''
    newProvenance.value = 'trovara_grown'
    newCategory.value = 'fresh_from_trovara'
    newFamilyBasketQuantity.value = 0
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('products.addFailed')
  } finally {
    creating.value = false
  }
}

function openEdit(p: Product) {
  editing.value = p
  editName.value = p.name
  editSku.value = p.sku
  editUnit.value = p.unit
  editPriceNaira.value = p.priceKobo > 0 ? p.priceKobo / 100 : ''
  editActive.value = p.active
  editProvenance.value = p.provenance
  editCategory.value = p.category
  editFamilyBasketQuantity.value = p.familyBasketQuantity
  editInventoryItemId.value = p.inventoryItemId ?? ''
}

function inventoryChoicesFor(product: Product) {
  return inventoryOptions.value.filter(
    (item) => !item.productId || item.productId === product.id || item.id === product.inventoryItemId,
  )
}

function cancelEdit() {
  editing.value = null
}

async function saveEdit() {
  if (!editing.value) return
  savingEdit.value = true
  error.value = null
  try {
    await api(`/api/products/${editing.value.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        sku: editSku.value.trim().toUpperCase(),
        name: editName.value.trim(),
        unit: editUnit.value.trim() || 'unit',
        priceKobo: nairaToKobo(editPriceNaira.value),
        active: editActive.value,
        provenance: editProvenance.value,
        category: editCategory.value,
        familyBasketQuantity: editFamilyBasketQuantity.value,
        inventoryItemId: editInventoryItemId.value || null,
      }),
    })
    editing.value = null
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('products.saveFailed')
  } finally {
    savingEdit.value = false
  }
}

async function addDeliverySlot() {
  if (!newDelivery.label.trim()) return
  savingDelivery.value = true
  error.value = null
  try {
    await api('/api/products/delivery-slots', {
      method: 'POST',
      body: JSON.stringify({
        ...newDelivery,
        label: newDelivery.label.trim(),
        sortOrder: deliverySlots.value.length + 1,
      }),
    })
    newDelivery.label = ''
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('products.deliverySaveFailed')
  } finally {
    savingDelivery.value = false
  }
}

async function toggleDeliverySlot(slot: DeliverySlot) {
  savingDelivery.value = true
  error.value = null
  try {
    await api(`/api/products/delivery-slots/${slot.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: !slot.active }),
    })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('products.deliverySaveFailed')
  } finally {
    savingDelivery.value = false
  }
}

const dayNames = computed(() => [
  t('products.sunday'),
  t('products.monday'),
  t('products.tuesday'),
  t('products.wednesday'),
  t('products.thursday'),
  t('products.friday'),
  t('products.saturday'),
])

async function deactivate(p: Product) {
  error.value = null
  try {
    await api(`/api/products/${p.id}`, { method: 'DELETE' })
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('products.removeFailed')
  }
}
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-os-fg">{{ t('products.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1">
        {{ t('products.subtitle') }}
      </p>
    </div>

    <p v-if="error" class="mt-4 text-sm text-red-300">{{ error }}</p>

    <!-- Add product -->
    <CollapsibleSection
      class="mt-6"
      :title="t('products.addProduct')"
      :default-open="false"
      test-id="products-create-section"
    >
      <div class="grid gap-3 sm:grid-cols-[1fr_2fr_1fr_1fr_auto]">
        <input
          v-model="newSku"
          aria-label="SKU"
          placeholder="SKU"
          maxlength="40"
          class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white uppercase"
        />
        <input
          v-model="newName"
          :aria-label="t('products.productNamePlaceholder')"
          :placeholder="t('products.productNamePlaceholder')"
          class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <input
          v-model="newUnit"
          :aria-label="t('products.unit')"
          list="product-unit-options"
          :placeholder="t('products.unit')"
          maxlength="40"
          class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          :title="t('products.unitHint')"
        />
        <input
          v-model.number="newPriceNaira"
          :aria-label="t('products.price')"
          type="number"
          min="0"
          step="0.01"
          :placeholder="t('products.price')"
          class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <button
          :disabled="creating || !newName.trim() || !newSku.trim()"
          class="px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green text-sm font-semibold hover:bg-farm-green/30 disabled:opacity-40"
          @click="createProduct"
        >
          {{ creating ? t('products.adding') : t('products.add') }}
        </button>
      </div>
      <div class="mt-3 grid gap-3 sm:grid-cols-3">
        <label class="block">
          <span class="text-xs text-slate-400">{{ t('products.provenance') }}</span>
          <select
            v-model="newProvenance"
            class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="trovara_grown">{{ t('products.trovaraGrown') }}</option>
            <option value="trovara_sourced">{{ t('products.trovaraSourced') }}</option>
          </select>
        </label>
        <label class="block">
          <span class="text-xs text-slate-400">{{ t('products.category') }}</span>
          <input
            v-model="newCategory"
            class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
        </label>
        <label class="block">
          <span class="text-xs text-slate-400">{{ t('products.familyBasketQuantity') }}</span>
          <input
            v-model.number="newFamilyBasketQuantity"
            type="number"
            min="0"
            step="1"
            class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <span class="mt-1 block text-[11px] text-slate-500">{{ t('products.familyBasketHint') }}</span>
        </label>
      </div>
    </CollapsibleSection>

    <CollapsibleSection
      class="mt-4"
      :title="t('products.deliveryDays')"
      :default-open="false"
      test-id="products-delivery-section"
    >
      <p class="mb-4 text-sm text-slate-400">{{ t('products.deliveryDaysHint') }}</p>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr_1fr_auto]">
        <label class="block">
          <span class="text-xs text-slate-400">{{ t('products.deliveryLabel') }}</span>
          <input
            v-model="newDelivery.label"
            class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
        </label>
        <label class="block">
          <span class="text-xs text-slate-400">{{ t('products.deliveryDay') }}</span>
          <select
            v-model.number="newDelivery.dayOfWeek"
            class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option v-for="(day, index) in dayNames" :key="day" :value="index">{{ day }}</option>
          </select>
        </label>
        <label class="block">
          <span class="text-xs text-slate-400">{{ t('products.startTime') }}</span>
          <input
            v-model="newDelivery.startTime"
            type="time"
            class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
        </label>
        <label class="block">
          <span class="text-xs text-slate-400">{{ t('products.endTime') }}</span>
          <input
            v-model="newDelivery.endTime"
            type="time"
            class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
        </label>
        <label class="block">
          <span class="text-xs text-slate-400">{{ t('products.cutoffHours') }}</span>
          <input
            v-model.number="newDelivery.cutoffHours"
            type="number"
            min="0"
            class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
        </label>
        <button
          :disabled="savingDelivery || !newDelivery.label.trim()"
          class="self-end px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green text-sm font-semibold hover:bg-farm-green/30 disabled:opacity-40"
          @click="addDeliverySlot"
        >
          {{ t('products.addDeliveryDay') }}
        </button>
      </div>
      <div v-if="deliverySlots.length" class="mt-4 grid gap-2 sm:grid-cols-2">
        <div
          v-for="slot in deliverySlots"
          :key="slot.id"
          class="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3"
          :class="{ 'opacity-50': !slot.active }"
        >
          <div>
            <p class="font-semibold text-white">{{ slot.label }}</p>
            <p class="text-xs text-slate-400">
              {{ dayNames[slot.dayOfWeek] }} · {{ slot.startTime }}–{{ slot.endTime }} ·
              {{ slot.cutoffHours }}h {{ t('products.cutoffHours').toLowerCase() }}
            </p>
          </div>
          <button
            class="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
            :disabled="savingDelivery"
            @click="toggleDeliverySlot(slot)"
          >
            {{ slot.active ? t('products.disable') : t('products.enable') }}
          </button>
        </div>
      </div>
    </CollapsibleSection>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('products.loading') }}</div>

    <div v-else-if="!products.length" class="mt-8 text-slate-500 text-sm">
      {{ t('products.empty') }}
    </div>

    <div v-else class="mt-6 space-y-3">
      <div
        v-for="p in products"
        :key="p.id"
        class="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between gap-4"
        :class="{ 'opacity-50': !p.active }"
      >
        <div class="min-w-0">
          <p class="font-semibold text-white truncate">
            {{ p.name }}
            <span v-if="!p.active" class="text-xs text-slate-500">{{ t('products.inactive') }}</span>
          </p>
          <p class="mt-0.5 font-mono text-[11px] uppercase tracking-wide text-farm-green">{{ p.sku }}</p>
          <p class="text-xs text-slate-400 mt-0.5">
            {{ priceLabel(p) }} <span class="text-slate-600">/ {{ p.unit }}</span>
          </p>
          <p class="mt-1 text-[11px] font-semibold uppercase tracking-wide text-amber-300">
            {{ p.provenance === 'trovara_sourced' ? t('products.trovaraSourced') : t('products.trovaraGrown') }}
          </p>
          <p v-if="p.familyBasketQuantity > 0" class="mt-1 text-[11px] text-farm-green">
            {{ t('products.familyBasketIncluded', { quantity: p.familyBasketQuantity, unit: p.unit }) }}
          </p>
          <p class="text-[11px] mt-1" :class="p.inventoryItemId ? 'text-farm-green' : 'text-slate-600'">
            <template v-if="p.inventoryItemId">
              {{
                t('products.stockLinked', {
                  sku: p.inventorySku,
                  qty: p.inventoryQuantity,
                  unit: p.inventoryUnit,
                })
              }}
            </template>
            <template v-else>{{ t('products.stockUnlinked') }}</template>
          </p>
        </div>
        <div class="flex gap-2 flex-shrink-0">
          <button
            class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700"
            @click="openEdit(p)"
          >
            {{ t('products.edit') }}
          </button>
          <button
            v-if="p.active && canRemove"
            class="text-xs px-3 py-1.5 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60"
            @click="deactivate(p)"
          >
            {{ t('products.remove') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Edit modal -->
    <div
      v-if="editing"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      @click.self="cancelEdit"
    >
      <div class="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl p-6">
        <h3 class="font-bold text-white">{{ t('products.editProduct') }}</h3>
        <div class="mt-4 space-y-3">
          <label class="block">
            <span class="text-xs text-slate-400">SKU</span>
            <input
              v-model="editSku"
              maxlength="40"
              class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white uppercase"
            />
          </label>
          <label class="block">
            <span class="text-xs text-slate-400">{{ t('products.name') }}</span>
            <input
              v-model="editName"
              class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
          </label>
          <label class="block">
            <span class="text-xs text-slate-400">{{ t('products.unit') }}</span>
            <input
              v-model="editUnit"
              list="product-unit-options"
              maxlength="40"
              class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
            <span class="mt-1 block text-[11px] text-slate-500">{{ t('products.unitHint') }}</span>
          </label>
          <label class="block">
            <span class="text-xs text-slate-400">{{ t('products.priceEdit') }}</span>
            <input
              v-model.number="editPriceNaira"
              type="number"
              min="0"
              step="0.01"
              class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
          </label>
          <label class="block">
            <span class="text-xs text-slate-400">{{ t('products.provenance') }}</span>
            <select
              v-model="editProvenance"
              class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="trovara_grown">{{ t('products.trovaraGrown') }}</option>
              <option value="trovara_sourced">{{ t('products.trovaraSourced') }}</option>
            </select>
          </label>
          <label class="block">
            <span class="text-xs text-slate-400">{{ t('products.category') }}</span>
            <input
              v-model="editCategory"
              class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
          </label>
          <label class="block">
            <span class="text-xs text-slate-400">{{ t('products.familyBasketQuantity') }}</span>
            <input
              v-model.number="editFamilyBasketQuantity"
              type="number"
              min="0"
              step="1"
              class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
          </label>
          <label class="flex items-center gap-2 text-sm text-slate-300">
            <input v-model="editActive" type="checkbox" class="rounded" />
            {{ t('products.activeShown') }}
          </label>
          <label class="block">
            <span class="text-xs text-slate-400">{{ t('products.stockLink') }}</span>
            <select
              v-model="editInventoryItemId"
              class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="">{{ t('products.stockLinkNone') }}</option>
              <option
                v-for="item in inventoryChoicesFor(editing)"
                :key="item.id"
                :value="item.id"
              >
                {{ item.sku }} · {{ item.name }} ({{ item.quantity }} {{ item.unit }})
              </option>
            </select>
          </label>
        </div>
        <div class="mt-6 flex justify-end gap-2">
          <button
            class="px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700"
            @click="cancelEdit"
          >
            {{ t('products.cancel') }}
          </button>
          <button
            :disabled="savingEdit || !editName.trim() || !editSku.trim()"
            class="px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green text-sm font-semibold hover:bg-farm-green/30 disabled:opacity-40"
            @click="saveEdit"
          >
            {{ savingEdit ? t('products.saving') : t('products.save') }}
          </button>
        </div>
      </div>
    </div>

    <datalist id="product-unit-options">
      <option v-for="u in UNIT_OPTIONS" :key="u" :value="u" />
    </datalist>
  </AppLayout>
</template>
