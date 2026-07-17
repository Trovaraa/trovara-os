<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

const { t } = useI18n()

type Product = {
  id: string
  name: string
  unit: string
  priceKobo: number
  currency: string
  active: boolean
  sortOrder: number
}

const UNIT_OPTIONS = ['bunch', 'piece', 'pack', 'bird', 'crate', 'kg', 'bag', 'unit']

const products = ref<Product[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

const newName = ref('')
const newUnit = ref('unit')
const newPriceNaira = ref<number | ''>('')
const creating = ref(false)

const editing = ref<Product | null>(null)
const editName = ref('')
const editUnit = ref('unit')
const editPriceNaira = ref<number | ''>('')
const editActive = ref(true)
const savingEdit = ref(false)

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
    const data = await api<{ products: Product[] }>('/api/products')
    products.value = data.products
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
        name: newName.value.trim(),
        unit: newUnit.value.trim() || 'unit',
        priceKobo: nairaToKobo(newPriceNaira.value),
        sortOrder: products.value.length + 1,
      }),
    })
    newName.value = ''
    newUnit.value = 'unit'
    newPriceNaira.value = ''
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
  editUnit.value = p.unit
  editPriceNaira.value = p.priceKobo > 0 ? p.priceKobo / 100 : ''
  editActive.value = p.active
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
        name: editName.value.trim(),
        unit: editUnit.value.trim() || 'unit',
        priceKobo: nairaToKobo(editPriceNaira.value),
        active: editActive.value,
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
      <h2 class="text-2xl font-black text-white">{{ t('products.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1">
        {{ t('products.subtitle') }}
      </p>
    </div>

    <p v-if="error" class="mt-4 text-sm text-red-300">{{ error }}</p>

    <!-- Add product -->
    <div class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
      <h3 class="font-bold text-white text-sm">{{ t('products.addProduct') }}</h3>
      <div class="mt-4 grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto]">
        <input
          v-model="newName"
          :placeholder="t('products.productName')"
          class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <input
          v-model="newUnit"
          list="unit-options"
          :placeholder="t('products.unit')"
          class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <input
          v-model.number="newPriceNaira"
          type="number"
          min="0"
          step="0.01"
          :placeholder="t('products.price')"
          class="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
        />
        <button
          :disabled="creating || !newName.trim()"
          class="px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green text-sm font-semibold hover:bg-farm-green/30 disabled:opacity-40"
          @click="createProduct"
        >
          {{ creating ? t('products.adding') : t('products.add') }}
        </button>
      </div>
      <datalist id="unit-options">
        <option v-for="u in UNIT_OPTIONS" :key="u" :value="u" />
      </datalist>
    </div>

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
          <p class="text-xs text-slate-400 mt-0.5">
            {{ priceLabel(p) }} <span class="text-slate-600">/ {{ p.unit }}</span>
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
            v-if="p.active"
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
              list="unit-options"
              class="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
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
          <label class="flex items-center gap-2 text-sm text-slate-300">
            <input v-model="editActive" type="checkbox" class="rounded" />
            {{ t('products.activeShown') }}
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
            :disabled="savingEdit || !editName.trim()"
            class="px-4 py-2 rounded-lg bg-farm-green/20 text-farm-green text-sm font-semibold hover:bg-farm-green/30 disabled:opacity-40"
            @click="saveEdit"
          >
            {{ savingEdit ? t('products.saving') : t('products.save') }}
          </button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
