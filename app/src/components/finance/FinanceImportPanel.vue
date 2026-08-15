<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'

type CostCentre = { code: string; name: string }
type ImportRow = {
  rowNumber: number
  included: boolean
  expenseDate: string
  description: string
  category: string
  amount: number
  currency: string
  vendor: string
  receiptRef: string
  costCentreCode: string
  issues: string[]
}

defineProps<{ costCentres: CostCentre[]; categories: readonly string[] }>()
const emit = defineEmits<{ imported: [] }>()
const { t } = useI18n()

const file = ref<File | null>(null)
const token = ref('')
const filename = ref('')
const rows = ref<ImportRow[]>([])
const busy = ref(false)
const error = ref<string | null>(null)
const result = ref<string | null>(null)

const selectedRows = computed(() => rows.value.filter((row) => row.included))
const invalidRows = computed(() => selectedRows.value.filter((row) => !isValid(row)))

function isValid(row: ImportRow) {
  return Boolean(row.expenseDate && row.description.trim() && row.costCentreCode && Number.isInteger(row.amount) && row.amount >= 0)
}

function choose(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
  rows.value = []
  token.value = ''
  result.value = null
}

async function preview() {
  if (!file.value) return
  busy.value = true
  error.value = null
  result.value = null
  try {
    const form = new FormData()
    form.append('file', file.value)
    const data = await api<{ token: string; filename: string; rows: ImportRow[] }>('/api/finance/imports/preview', { method: 'POST', body: form })
    token.value = data.token
    filename.value = data.filename
    rows.value = data.rows.map((row) => ({ ...row, expenseDate: row.expenseDate ? row.expenseDate.slice(0, 10) : '' }))
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('financeImport.previewFailed')
  } finally {
    busy.value = false
  }
}

async function commit() {
  if (!token.value || !selectedRows.value.length || invalidRows.value.length) return
  busy.value = true
  error.value = null
  result.value = null
  try {
    const data = await api<{ imported: number; duplicates: number }>('/api/finance/imports/commit', {
      method: 'POST',
      body: JSON.stringify({
        token: token.value,
        rows: rows.value.map(({ issues: _issues, expenseDate, ...row }) => ({
          ...row,
          expenseDate: new Date(`${expenseDate}T12:00:00.000Z`).toISOString(),
        })),
      }),
    })
    result.value = `${t('financeImport.imported', { count: data.imported })}${data.duplicates ? t('financeImport.duplicates', { count: data.duplicates }) : ''}.`
    token.value = ''
    rows.value = []
    file.value = null
    emit('imported')
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('financeImport.importFailed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="rounded-2xl border border-slate-800 bg-slate-900 p-5" aria-labelledby="finance-import-title">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 id="finance-import-title" class="font-bold text-white">{{ t('financeImport.title') }}</h3>
        <p class="mt-1 text-sm text-slate-400">{{ t('financeImport.description') }}</p>
      </div>
      <span class="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">{{ t('financeImport.previewFirst') }}</span>
    </div>

    <div class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
      <label class="min-w-0 flex-1 text-xs text-slate-400">
        {{ t('financeImport.file') }}
        <input type="file" accept=".xlsx,.csv,.pdf" class="mt-1 block min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-1 file:text-slate-200" @change="choose" />
      </label>
      <button type="button" class="min-h-11 rounded-xl bg-farm-green px-4 py-2 text-sm font-bold text-white disabled:opacity-50" :disabled="busy || !file" @click="preview">
        {{ busy ? t('financeImport.reading') : t('financeImport.preview') }}
      </button>
    </div>

    <p v-if="error" class="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">{{ error }}</p>
    <p v-if="result" class="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300" role="status">{{ result }}</p>

    <template v-if="rows.length">
      <div class="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-4">
        <div>
          <p class="text-sm font-semibold text-white">{{ filename }}</p>
          <p class="text-xs text-slate-400">{{ t('financeImport.selected', { selected: selectedRows.length, invalid: invalidRows.length }) }}</p>
        </div>
        <button type="button" class="min-h-11 rounded-xl bg-farm-green px-4 py-2 text-sm font-bold text-white disabled:opacity-50" :disabled="busy || !selectedRows.length || invalidRows.length > 0" @click="commit">
          {{ busy ? t('financeImport.importing') : t('financeImport.importCount', { count: selectedRows.length }) }}
        </button>
      </div>

      <div class="mt-4 space-y-3">
        <article v-for="row in rows" :key="row.rowNumber" class="rounded-xl border p-4" :class="row.included && !isValid(row) ? 'border-amber-500/40 bg-amber-500/5' : 'border-slate-800 bg-slate-950/60'">
          <div class="flex items-center justify-between gap-3">
            <label class="flex min-h-11 items-center gap-2 text-sm font-semibold text-white">
              <input v-model="row.included" type="checkbox" class="h-5 w-5 rounded border-slate-600" />
              {{ t('financeImport.row', { number: row.rowNumber }) }}
            </label>
            <span v-if="row.included && !isValid(row)" class="text-xs font-semibold text-amber-300">{{ t('financeImport.attention') }}</span>
          </div>
          <div v-if="row.included" class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label class="text-xs text-slate-400">{{ t('financeImport.date') }}<input v-model="row.expenseDate" type="date" required class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
            <label class="text-xs text-slate-400">{{ t('financeImport.amount') }}<input v-model.number="row.amount" type="number" min="0" step="1" required class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
            <label class="text-xs text-slate-400">{{ t('financeImport.category') }}<select v-model="row.category" class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white"><option v-for="category in categories" :key="category" :value="category">{{ category }}</option></select></label>
            <label class="text-xs text-slate-400">{{ t('financeImport.costCentre') }}<select v-model="row.costCentreCode" required class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white"><option value="">{{ t('financeImport.choose') }}</option><option v-for="centre in costCentres" :key="centre.code" :value="centre.code">{{ centre.code }} · {{ centre.name }}</option></select></label>
            <label class="text-xs text-slate-400 sm:col-span-2">{{ t('financeImport.descriptionLabel') }}<input v-model="row.description" maxlength="500" required class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
            <label class="text-xs text-slate-400">{{ t('financeImport.vendor') }}<input v-model="row.vendor" maxlength="200" class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
            <label class="text-xs text-slate-400">{{ t('financeImport.reference') }}<input v-model="row.receiptRef" maxlength="200" class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
          </div>
        </article>
      </div>
    </template>
  </section>
</template>
