<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/lib/api'

type CostCentre = { code: string; name: string }
type SheetClassification = 'expenses' | 'budget' | 'contributions' | 'ignore'
type ImportSheet = { name: string; suggestedClassification: SheetClassification; classification: SheetClassification; rowCount: number | null; detectedTotal: number | null }
type ImportRow = {
  rowNumber: number
  sourceSheet: string
  sourceRecordId: string
  sourceRowHash: string
  included: boolean
  expenseDate: string
  description: string
  category: string
  amount: number
  amountDerivedFromFormula: boolean
  amountReviewed: boolean
  currency: string
  vendor: string
  payer: string
  fundingStatus: string
  projectPhase: string
  receiptRef: string
  costCentreCode: string
  issues: string[]
}

defineProps<{ costCentres: CostCentre[]; categories: readonly string[] }>()
const emit = defineEmits<{ imported: [] }>()
const { t } = useI18n()

const file = ref<File | null>(null)
const sheets = ref<ImportSheet[]>([])
const expectedTotal = ref<number | null>(null)
const token = ref('')
const filename = ref('')
const rows = ref<ImportRow[]>([])
const busy = ref(false)
const error = ref<string | null>(null)
const result = ref<string | null>(null)

const selectedRows = computed(() => rows.value.filter((row) => row.included))
const invalidRows = computed(() => selectedRows.value.filter((row) => !isValid(row)))
const selectedTotal = computed(() => selectedRows.value.reduce((sum, row) => sum + (Number(row.amount) || 0), 0))
const variance = computed(() => selectedTotal.value - (expectedTotal.value ?? 0))
const hasExpenseSheet = computed(() => sheets.value.some((sheet) => sheet.classification === 'expenses'))
const canPreview = computed(() => Boolean(file.value && sheets.value.length && hasExpenseSheet.value && Number.isInteger(expectedTotal.value) && (expectedTotal.value ?? -1) >= 0))
const money = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 })

function isValid(row: ImportRow) {
  return Boolean(row.expenseDate && row.description.trim() && row.category && row.costCentreCode && Number.isInteger(row.amount) && row.amount >= 0 && (!row.amountDerivedFromFormula || row.amountReviewed))
}

function choose(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
  sheets.value = []
  expectedTotal.value = null
  rows.value = []
  token.value = ''
  result.value = null
}

async function inspectWorkbook() {
  if (!file.value) return
  busy.value = true
  error.value = null
  result.value = null
  try {
    const form = new FormData()
    form.append('file', file.value)
    const data = await api<{ filename: string; sheets: Array<Omit<ImportSheet, 'classification'>> }>('/api/finance/imports/inspect', { method: 'POST', body: form })
    filename.value = data.filename
    sheets.value = data.sheets.map((sheet) => ({ ...sheet, classification: sheet.suggestedClassification }))
    const suggestedTotal = data.sheets.find((sheet) => sheet.suggestedClassification === 'expenses' && sheet.detectedTotal != null)?.detectedTotal
    expectedTotal.value = suggestedTotal ?? null
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('financeImport.inspectFailed')
  } finally {
    busy.value = false
  }
}

async function preview() {
  if (!file.value || !canPreview.value) return
  busy.value = true
  error.value = null
  result.value = null
  try {
    const form = new FormData()
    form.append('file', file.value)
    form.append('sheetSelections', JSON.stringify(sheets.value.map(({ name, classification }) => ({ name, classification }))))
    form.append('expectedTotal', String(expectedTotal.value))
    const data = await api<{ token: string; filename: string; rows: ImportRow[]; expectedTotal: number }>('/api/finance/imports/preview', { method: 'POST', body: form })
    token.value = data.token
    filename.value = data.filename
    expectedTotal.value = data.expectedTotal
    rows.value = data.rows.map((row) => ({ ...row, expenseDate: row.expenseDate ? row.expenseDate.slice(0, 10) : '' }))
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('financeImport.previewFailed')
  } finally {
    busy.value = false
  }
}

async function commit() {
  if (!token.value || !selectedRows.value.length || invalidRows.value.length || variance.value !== 0) return
  busy.value = true
  error.value = null
  result.value = null
  try {
    const data = await api<{ imported: number; duplicates: number }>('/api/finance/imports/commit', {
      method: 'POST',
      body: JSON.stringify({
        token: token.value,
        rows: selectedRows.value.map(({ issues: _issues, expenseDate, ...row }) => ({
          ...row,
          expenseDate: new Date(`${expenseDate}T12:00:00.000Z`).toISOString(),
        })),
      }),
    })
    result.value = `${t('financeImport.imported', { count: data.imported })}${data.duplicates ? t('financeImport.duplicates', { count: data.duplicates }) : ''}.`
    token.value = ''
    rows.value = []
    sheets.value = []
    expectedTotal.value = null
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
      <button type="button" class="min-h-11 rounded-xl bg-farm-green px-4 py-2 text-sm font-bold text-white disabled:opacity-50" :disabled="busy || !file" @click="inspectWorkbook">
        {{ busy ? t('financeImport.reading') : t('financeImport.inspect') }}
      </button>
    </div>

    <p v-if="error" class="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">{{ error }}</p>
    <p v-if="result" class="mt-3 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300" role="status">{{ result }}</p>

    <div v-if="sheets.length && !rows.length" class="mt-5 space-y-4 border-t border-slate-800 pt-4">
      <div>
        <h4 class="text-sm font-bold text-white">{{ t('financeImport.classifyTitle') }}</h4>
        <p class="mt-1 text-xs text-slate-400">{{ t('financeImport.classifyHelp') }}</p>
      </div>
      <div class="grid gap-3 lg:grid-cols-2">
        <label v-for="sheet in sheets" :key="sheet.name" class="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">
          <span class="block font-semibold text-white">{{ sheet.name }}</span>
          <span class="mt-1 block">{{ sheet.rowCount == null ? t('financeImport.rowCountUnknown') : t('financeImport.sheetRows', { count: sheet.rowCount }) }}</span>
          <select v-model="sheet.classification" class="mt-2 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-white">
            <option value="expenses">{{ t('financeImport.sheetTypes.expenses') }}</option>
            <option value="budget">{{ t('financeImport.sheetTypes.budget') }}</option>
            <option value="contributions">{{ t('financeImport.sheetTypes.contributions') }}</option>
            <option value="ignore">{{ t('financeImport.sheetTypes.ignore') }}</option>
          </select>
        </label>
      </div>
      <div class="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-950/60 p-4 sm:flex-row sm:items-end sm:justify-between">
        <label class="text-xs text-slate-400">
          {{ t('financeImport.expectedTotal') }}
          <input v-model.number="expectedTotal" type="number" min="0" step="1" required class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white sm:w-64" />
          <span class="mt-1 block">{{ t('financeImport.expectedTotalHelp') }}</span>
        </label>
        <button type="button" class="min-h-11 rounded-xl bg-farm-green px-4 py-2 text-sm font-bold text-white disabled:opacity-50" :disabled="busy || !canPreview" @click="preview">
          {{ busy ? t('financeImport.reading') : t('financeImport.preview') }}
        </button>
      </div>
    </div>

    <template v-if="rows.length">
      <div class="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-4">
        <div>
          <p class="text-sm font-semibold text-white">{{ filename }}</p>
          <p class="text-xs text-slate-400">{{ t('financeImport.selected', { selected: selectedRows.length, invalid: invalidRows.length }) }}</p>
        </div>
        <button type="button" class="min-h-11 rounded-xl bg-farm-green px-4 py-2 text-sm font-bold text-white disabled:opacity-50" :disabled="busy || !selectedRows.length || invalidRows.length > 0 || variance !== 0" @click="commit">
          {{ busy ? t('financeImport.importing') : t('financeImport.importCount', { count: selectedRows.length }) }}
        </button>
      </div>

      <div class="mt-4 grid gap-3 rounded-xl border p-4 sm:grid-cols-3" :class="variance === 0 ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5'">
        <div><p class="text-xs text-slate-400">{{ t('financeImport.expected') }}</p><p class="mt-1 font-bold text-white">{{ money.format(expectedTotal ?? 0) }}</p></div>
        <div><p class="text-xs text-slate-400">{{ t('financeImport.selectedTotal') }}</p><p class="mt-1 font-bold text-white">{{ money.format(selectedTotal) }}</p></div>
        <div><p class="text-xs text-slate-400">{{ t('financeImport.difference') }}</p><p class="mt-1 font-bold" :class="variance === 0 ? 'text-emerald-300' : 'text-amber-300'">{{ money.format(variance) }}</p></div>
        <p v-if="variance !== 0" class="text-xs text-amber-200 sm:col-span-3">{{ t('financeImport.reconcileBlocked') }}</p>
      </div>

      <div class="mt-4 space-y-3">
        <article v-for="row in rows" :key="row.rowNumber" class="rounded-xl border p-4" :class="row.included && !isValid(row) ? 'border-amber-500/40 bg-amber-500/5' : 'border-slate-800 bg-slate-950/60'">
          <div class="flex items-center justify-between gap-3">
            <label class="flex min-h-11 items-center gap-2 text-sm font-semibold text-white">
              <input v-model="row.included" type="checkbox" class="h-5 w-5 rounded border-slate-600" />
              {{ t('financeImport.sourceLocation', { sheet: row.sourceSheet, number: row.rowNumber }) }}
            </label>
            <span v-if="row.included && !isValid(row)" class="text-xs font-semibold text-amber-300">{{ t('financeImport.attention') }}</span>
          </div>
          <div v-if="row.included" class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label class="text-xs text-slate-400">{{ t('financeImport.date') }}<input v-model="row.expenseDate" type="date" required class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
            <label class="text-xs text-slate-400">{{ t('financeImport.amount') }}<input v-model.number="row.amount" type="number" min="0" step="1" required class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
            <label class="text-xs text-slate-400">{{ t('financeImport.category') }}<select v-model="row.category" required class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white"><option value="">{{ t('financeImport.choose') }}</option><option v-for="category in categories" :key="category" :value="category">{{ category }}</option></select></label>
            <label class="text-xs text-slate-400">{{ t('financeImport.costCentre') }}<select v-model="row.costCentreCode" required class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white"><option value="">{{ t('financeImport.choose') }}</option><option v-for="centre in costCentres" :key="centre.code" :value="centre.code">{{ centre.code }} · {{ centre.name }}</option></select></label>
            <label class="text-xs text-slate-400 sm:col-span-2">{{ t('financeImport.descriptionLabel') }}<input v-model="row.description" maxlength="500" required class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
            <label class="text-xs text-slate-400">{{ t('financeImport.vendor') }}<input v-model="row.vendor" maxlength="200" class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
            <label class="text-xs text-slate-400">{{ t('financeImport.payer') }}<input v-model="row.payer" maxlength="200" class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
            <label class="text-xs text-slate-400">{{ t('financeImport.fundingStatus') }}<input v-model="row.fundingStatus" maxlength="50" class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
            <label class="text-xs text-slate-400">{{ t('financeImport.projectPhase') }}<input v-model="row.projectPhase" maxlength="200" class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
            <label class="text-xs text-slate-400">{{ t('financeImport.reference') }}<input v-model="row.receiptRef" maxlength="200" class="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-white" /></label>
            <label v-if="row.amountDerivedFromFormula" class="flex min-h-11 items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 text-xs text-amber-200 lg:col-span-2">
              <input v-model="row.amountReviewed" type="checkbox" class="h-5 w-5 rounded border-slate-600" />
              {{ t('financeImport.formulaReview') }}
            </label>
          </div>
        </article>
      </div>
    </template>
  </section>
</template>
