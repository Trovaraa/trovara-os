import { createHmac, createHash, timingSafeEqual } from 'node:crypto'
import readWorkbook from 'read-excel-file/node'
import JSZip from 'jszip'
import { extractPdfPlainText } from './invoice-extract.js'
import { COST_CENTRES, COST_CENTRE_CODES, type CostCentreCode } from './cost-centres.js'

export const IMPORT_CATEGORIES = ['inputs', 'labour', 'equipment', 'transport', 'utilities', 'feed', 'medicine', 'other'] as const
export type ImportCategory = (typeof IMPORT_CATEGORIES)[number]
export const IMPORT_SHEET_CLASSIFICATIONS = ['expenses', 'budget', 'contributions', 'ignore'] as const
export type ImportSheetClassification = (typeof IMPORT_SHEET_CLASSIFICATIONS)[number]

export type FinanceImportSheetSelection = {
  name: string
  classification: ImportSheetClassification
}

export type FinanceImportRow = {
  rowNumber: number
  sourceSheet: string
  sourceRecordId: string
  sourceRowHash: string
  included: boolean
  expenseDate: string
  description: string
  category: ImportCategory | ''
  amount: number
  amountDerivedFromFormula: boolean
  amountReviewed: boolean
  currency: string
  vendor: string
  payer: string
  fundingStatus: string
  projectPhase: string
  receiptRef: string
  costCentreCode: CostCentreCode | ''
  issues: string[]
}

type PreviewTokenPayload = {
  farmId: string
  userId: string
  filename: string
  fileHash: string
  sourceSheets: string[]
  formulaRefs: string[]
  expectedTotal: number
  exp: number
}

type WorkbookFormulaMap = Map<string, Map<string, string>>

function tokenSecret() {
  const secret = process.env.FINANCE_IMPORT_SECRET?.trim()
  if (secret) return secret
  if (process.env.NODE_ENV === 'production') throw new Error('FINANCE_IMPORT_SECRET_NOT_CONFIGURED')
  return 'trovara-development-finance-import-secret'
}

export function createFinanceImportToken(payload: Omit<PreviewTokenPayload, 'exp'>) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 30 * 60_000 })).toString('base64url')
  const signature = createHmac('sha256', tokenSecret()).update(body).digest('base64url')
  return `${body}.${signature}`
}

export function verifyFinanceImportToken(token: string, farmId: string, userId: string): PreviewTokenPayload {
  const [body, supplied] = token.split('.')
  if (!body || !supplied) throw new Error('INVALID_IMPORT_TOKEN')
  const expected = createHmac('sha256', tokenSecret()).update(body).digest()
  const actual = Buffer.from(supplied, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('INVALID_IMPORT_TOKEN')
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PreviewTokenPayload
  if (payload.farmId !== farmId || payload.userId !== userId || payload.exp < Date.now()) throw new Error('INVALID_IMPORT_TOKEN')
  return payload
}

function normalizedHeader(value: unknown) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

const HEADER_ALIASES: Record<string, string[]> = {
  sourceRecordId: ['sn', 'serial', 'serialnumber', 'id', 'transactionid'],
  expenseDate: ['date', 'expensedate', 'transactiondate', 'spenton'],
  description: ['description', 'costdescription', 'details', 'narration', 'transaction', 'item'],
  category: ['category', 'expensecategory', 'type'],
  amount: ['amount', 'total', 'value', 'debit', 'spent'],
  currency: ['currency', 'curr'],
  vendor: ['vendor', 'supplier', 'payee', 'merchant'],
  payer: ['payer', 'paidby', 'fundedby'],
  fundingStatus: ['fundingstatus', 'fundstatus', 'fundedstatus'],
  projectPhase: ['projectphase', 'phase', 'section'],
  receiptRef: ['receiptref', 'receipt', 'reference', 'ref', 'invoicenumber'],
  costCentreCode: ['costcentre', 'costcentercode', 'costcentrecode', 'department', 'crop'],
}

function resolveHeader(header: string): string | null {
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) if (aliases.includes(header)) return field
  return null
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (ch === '"' && quoted && text[i + 1] === '"') { cell += '"'; i += 1 }
    else if (ch === '"') quoted = !quoted
    else if (ch === ',' && !quoted) { row.push(cell); cell = '' }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell); cell = ''
      if (row.some((value) => value.trim())) rows.push(row)
      row = []
    } else cell += ch
  }
  row.push(cell)
  if (row.some((value) => value.trim())) rows.push(row)
  return rows
}

function valueText(value: unknown): string {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object' && 'text' in value) return String((value as { text: unknown }).text ?? '')
  if (typeof value === 'object' && 'result' in value) return String((value as { result: unknown }).result ?? '')
  return String(value).trim()
}

function parseAmount(value: unknown): number {
  if (typeof value === 'number') return Math.round(value)
  const cleaned = valueText(value).replace(/[₦$£€\s,]/g, '').replace(/^\((.*)\)$/, '-$1')
  const amount = Number(cleaned)
  return Number.isFinite(amount) ? Math.round(amount) : Number.NaN
}

function parseDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'number') {
    const parsed = new Date(Date.UTC(1899, 11, 30) + value * 86_400_000)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  const text = valueText(value)
  const dmy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (dmy) {
    const year = Number(dmy[3]) < 100 ? 2000 + Number(dmy[3]) : Number(dmy[3])
    const date = new Date(Date.UTC(year, Number(dmy[2]) - 1, Number(dmy[1]), 12))
    if (date.getUTCDate() === Number(dmy[1]) && date.getUTCMonth() === Number(dmy[2]) - 1) return date.toISOString()
  }
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function mapCategory(value: unknown): ImportCategory | '' {
  const text = valueText(value).toLowerCase()
  if (!text) return ''
  return IMPORT_CATEGORIES.find((category) => text.includes(category)) ?? ''
}

function mapCostCentre(value: unknown): CostCentreCode | '' {
  const text = valueText(value).trim().toLowerCase()
  const code = COST_CENTRE_CODES.find((item) => item.toLowerCase() === text)
  if (code) return code
  const centre = COST_CENTRES.find((item) => text && (item.name.toLowerCase().includes(text) || text.includes(item.name.toLowerCase())))
  return centre?.code ?? ''
}

function normalizeStableText(value: unknown) {
  return valueText(value).normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

function sourceRowHash(values: unknown[]) {
  return createHash('sha256').update(JSON.stringify(values.map(normalizeStableText))).digest('hex')
}

function normalizeRow(
  rowNumber: number,
  sourceSheet: string,
  rawValues: unknown[],
  source: Record<string, unknown>,
  projectPhase: string,
  amountDerivedFromFormula: boolean,
): FinanceImportRow {
  const amount = parseAmount(source.amount)
  const expenseDate = parseDate(source.expenseDate)
  const description = valueText(source.description).slice(0, 500)
  const category = mapCategory(source.category)
  const costCentreCode = mapCostCentre(source.costCentreCode)
  const issues: string[] = []
  if (!expenseDate) issues.push('Add or confirm the expense date')
  if (!description) issues.push('A description is required')
  if (!Number.isInteger(amount) || amount < 0) issues.push('Amount must be a non-negative whole number')
  if (!category) issues.push('Choose an expense category')
  if (!costCentreCode) issues.push('Choose a cost centre')
  if (amountDerivedFromFormula) issues.push('Formula-derived amount — verify the displayed value')
  return {
    rowNumber,
    sourceSheet,
    sourceRecordId: valueText(source.sourceRecordId).slice(0, 100),
    sourceRowHash: sourceRowHash(rawValues),
    included: true,
    expenseDate,
    description,
    category,
    amount: Number.isFinite(amount) ? amount : 0,
    amountDerivedFromFormula,
    amountReviewed: !amountDerivedFromFormula,
    currency: valueText(source.currency).toUpperCase().slice(0, 10) || 'NGN',
    vendor: valueText(source.vendor).slice(0, 200),
    payer: valueText(source.payer).slice(0, 200),
    fundingStatus: valueText(source.fundingStatus).slice(0, 50),
    projectPhase: valueText(source.projectPhase || projectPhase).slice(0, 200),
    receiptRef: valueText(source.receiptRef).slice(0, 200),
    costCentreCode,
    issues,
  }
}

function headerDetails(table: unknown[][]) {
  const headerIndex = table.findIndex((row) => row.map(normalizedHeader).some((cell) => HEADER_ALIASES.amount.includes(cell)))
  if (headerIndex < 0) return null
  const fields = table[headerIndex]!.map((value) => resolveHeader(normalizedHeader(value)))
  return { headerIndex, fields, amountColumn: fields.indexOf('amount') }
}

function columnLetters(index: number) {
  let value = index + 1
  let letters = ''
  while (value > 0) {
    value -= 1
    letters = String.fromCharCode(65 + (value % 26)) + letters
    value = Math.floor(value / 26)
  }
  return letters
}

function formulaRef(sheet: string, rowNumber: number, column: number) {
  return `${sheet}!${columnLetters(column)}${rowNumber}`
}

function grandTotal(table: unknown[][], sheet: string, formulas: Map<string, string>) {
  const details = headerDetails(table)
  if (!details || details.amountColumn < 0) return null
  const candidates: Array<{ rowNumber: number; amount: number }> = []
  for (let rowNumber = details.headerIndex + 2; rowNumber <= table.length; rowNumber += 1) {
    const formula = formulas.get(formulaRef(sheet, rowNumber, details.amountColumn))
    const amount = parseAmount(table[rowNumber - 1]?.[details.amountColumn])
    if (formula && /^(?:SUM|SUBTOTAL)\s*\(/i.test(formula.trim()) && Number.isInteger(amount) && amount >= 0) {
      candidates.push({ rowNumber, amount })
    }
  }
  return candidates.sort((a, b) => b.rowNumber - a.rowNumber)[0] ?? null
}

function tableToRows(table: unknown[][], sheet: string, formulas: Map<string, string>): FinanceImportRow[] {
  const details = headerDetails(table)
  if (!details) throw new Error('IMPORT_HEADERS_NOT_FOUND')
  const { headerIndex, fields, amountColumn } = details
  if (!fields.includes('amount') || !fields.includes('expenseDate') || !fields.includes('description')) throw new Error('IMPORT_REQUIRED_HEADERS_MISSING')
  const total = grandTotal(table, sheet, formulas)
  const endIndex = Math.min(total ? total.rowNumber - 1 : table.length, headerIndex + 501)
  const rows: FinanceImportRow[] = []
  let currentProjectPhase = ''
  for (let index = headerIndex + 1; index < endIndex; index += 1) {
    const values = table[index] ?? []
    const source: Record<string, unknown> = {}
    fields.forEach((field, column) => { if (field) source[field] = values[column] })
    const description = valueText(source.description)
    const rawAmount = valueText(source.amount)
    const firstCell = valueText(values[0])
    if (!description && !rawAmount && firstCell) {
      currentProjectPhase = firstCell.slice(0, 200)
      continue
    }
    if (!description || /^(?:grand\s+)?total$/i.test(description.trim())) continue
    const rowNumber = index + 1
    const hasFormula = amountColumn >= 0 && formulas.has(formulaRef(sheet, rowNumber, amountColumn))
    rows.push(normalizeRow(rowNumber, sheet, values, source, currentProjectPhase, hasFormula))
  }
  return rows
}

function decodeXml(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

async function workbookFormulas(buffer: Buffer): Promise<WorkbookFormulaMap> {
  const zip = await JSZip.loadAsync(buffer)
  const workbookXml = await zip.file('xl/workbook.xml')?.async('text')
  const relationshipsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('text')
  if (!workbookXml || !relationshipsXml) return new Map()
  const targets = new Map<string, string>()
  for (const match of relationshipsXml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/?\s*>/g)) {
    targets.set(match[1]!, match[2]!)
  }
  const result: WorkbookFormulaMap = new Map()
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*(?:r:id|id)="([^"]+)"[^>]*\/?\s*>/g)) {
    const sheetName = decodeXml(match[1]!)
    const target = targets.get(match[2]!)
    if (!target) continue
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
    const xml = await zip.file(path)?.async('text')
    if (!xml) continue
    const formulas = new Map<string, string>()
    for (const cell of xml.matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"[^>]*>([\s\S]*?)<\/c>/g)) {
      const formula = cell[2]!.match(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/)
      if (formula) formulas.set(`${sheetName}!${cell[1]}`, decodeXml(formula[1]!).trim())
    }
    result.set(sheetName, formulas)
  }
  return result
}

function suggestedClassification(name: string, table: unknown[][]): ImportSheetClassification {
  const normalizedName = name.toLowerCase()
  const details = headerDetails(table)
  if (details && details.fields.includes('expenseDate') && details.fields.includes('description') && details.fields.includes('amount')) return 'expenses'
  if (normalizedName.includes('partner') || normalizedName.includes('contribution')) return 'contributions'
  if (normalizedName.includes('cash call') || normalizedName.includes('budget')) return 'budget'
  return 'ignore'
}

export async function inspectFinanceImport(filename: string, buffer: Buffer) {
  const extension = validateImportFile(filename, buffer)
  if (extension !== '.xlsx') {
    return {
      fileHash: createHash('sha256').update(buffer).digest('hex'),
      sheets: [{ name: extension === '.csv' ? 'CSV transactions' : 'PDF transactions', suggestedClassification: 'expenses' as const, rowCount: null, detectedTotal: null }],
    }
  }
  const [sheets, formulas] = await Promise.all([readWorkbook(buffer), workbookFormulas(buffer)])
  if (!sheets.length) throw new Error('IMPORT_HAS_NO_WORKSHEET')
  return {
    fileHash: createHash('sha256').update(buffer).digest('hex'),
    sheets: sheets.map(({ sheet, data }) => ({
      name: sheet,
      suggestedClassification: suggestedClassification(sheet, data),
      rowCount: data.length,
      detectedTotal: grandTotal(data, sheet, formulas.get(sheet) ?? new Map())?.amount ?? null,
    })),
  }
}

async function pdfRows(buffer: Buffer) {
  const text = await extractPdfPlainText(buffer)
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const rows: FinanceImportRow[] = []
  for (let i = 0; i < lines.length && rows.length < 500; i += 1) {
    const line = lines[i]!
    const match = line.match(/(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})\s+(.+?)\s+(?:NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)$/i)
    if (!match) continue
    rows.push(normalizeRow(i + 1, 'PDF transactions', [line], { expenseDate: match[1], description: match[2], amount: match[3] }, '', false))
  }
  if (!rows.length) throw new Error('PDF_TRANSACTIONS_NOT_DETECTED')
  return rows
}

function validateImportFile(filename: string, buffer: Buffer) {
  const extension = filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? ''
  if (!['.xlsx', '.csv', '.pdf'].includes(extension)) throw new Error('UNSUPPORTED_IMPORT_FILE')
  if (extension === '.xlsx' && !buffer.subarray(0, 2).equals(Buffer.from('PK'))) throw new Error('IMPORT_FILE_TYPE_MISMATCH')
  if (extension === '.pdf' && buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('IMPORT_FILE_TYPE_MISMATCH')
  if (extension === '.csv' && buffer.includes(0)) throw new Error('IMPORT_FILE_TYPE_MISMATCH')
  return extension
}

export async function previewFinanceImport(
  filename: string,
  buffer: Buffer,
  options?: { sheetSelections?: FinanceImportSheetSelection[]; expectedTotal?: number },
) {
  const extension = validateImportFile(filename, buffer)
  let rows: FinanceImportRow[]
  let sourceSheets: string[]
  if (extension === '.pdf') {
    rows = await pdfRows(buffer)
    sourceSheets = ['PDF transactions']
  } else if (extension === '.csv') {
    rows = tableToRows(parseCsv(buffer.toString('utf8')), 'CSV transactions', new Map())
    sourceSheets = ['CSV transactions']
  } else {
    const [sheets, formulas] = await Promise.all([readWorkbook(buffer), workbookFormulas(buffer)])
    const selections = options?.sheetSelections ?? [{ name: sheets[0]?.sheet ?? '', classification: 'expenses' as const }]
    const expenseSheetNames = selections.filter((item) => item.classification === 'expenses').map((item) => item.name)
    if (!expenseSheetNames.length) throw new Error('IMPORT_EXPENSE_SHEET_REQUIRED')
    if (expenseSheetNames.some((name) => !sheets.some((sheet) => sheet.sheet === name))) throw new Error('IMPORT_SHEET_NOT_FOUND')
    sourceSheets = [...new Set(expenseSheetNames)]
    rows = sourceSheets.flatMap((name) => {
      const sheet = sheets.find((item) => item.sheet === name)!
      return tableToRows(sheet.data, name, formulas.get(name) ?? new Map())
    })
  }
  if (!rows.length) throw new Error('IMPORT_HAS_NO_DATA_ROWS')
  const selectedTotal = rows.reduce((sum, row) => sum + (row.included ? row.amount : 0), 0)
  const expectedTotal = options?.expectedTotal ?? selectedTotal
  if (!Number.isInteger(expectedTotal) || expectedTotal < 0) throw new Error('IMPORT_EXPECTED_TOTAL_INVALID')
  const formulaRefs = rows.filter((row) => row.amountDerivedFromFormula).map((row) => `${row.sourceSheet}!${row.rowNumber}`)
  return {
    rows,
    fileHash: createHash('sha256').update(buffer).digest('hex'),
    sourceSheets,
    formulaRefs,
    expectedTotal,
    selectedTotal,
    variance: selectedTotal - expectedTotal,
  }
}

export function financeImportFingerprint(row: Pick<FinanceImportRow, 'expenseDate' | 'description' | 'amount' | 'currency' | 'vendor' | 'receiptRef'>) {
  // Deliberately exclude filename, file hash, sheet, row, funding state, and
  // classification fields. Those change between workbook revisions while the
  // underlying expense remains the same.
  const stable = [
    row.expenseDate.slice(0, 10),
    normalizeStableText(row.description),
    String(row.amount),
    row.currency.trim().toUpperCase(),
    normalizeStableText(row.vendor),
    normalizeStableText(row.receiptRef),
  ].join('\u001f')
  return createHash('sha256').update(stable).digest('hex')
}
