import { createHmac, createHash, timingSafeEqual } from 'node:crypto'
import { readSheet } from 'read-excel-file/node'
import { extractPdfPlainText } from './invoice-extract.js'
import { COST_CENTRES, COST_CENTRE_CODES, type CostCentreCode } from './cost-centres.js'

export const IMPORT_CATEGORIES = ['inputs', 'labour', 'equipment', 'transport', 'utilities', 'feed', 'medicine', 'other'] as const
export type ImportCategory = (typeof IMPORT_CATEGORIES)[number]

export type FinanceImportRow = {
  rowNumber: number
  included: boolean
  expenseDate: string
  description: string
  category: ImportCategory
  amount: number
  currency: string
  vendor: string
  receiptRef: string
  costCentreCode: CostCentreCode | ''
  issues: string[]
}

type PreviewTokenPayload = { farmId: string; userId: string; filename: string; fileHash: string; exp: number }

function tokenSecret() {
  const secret = process.env.FINANCE_IMPORT_SECRET?.trim() || process.env.TOTP_ENCRYPTION_KEY?.trim()
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
  expenseDate: ['date', 'expensedate', 'transactiondate', 'spenton'],
  description: ['description', 'details', 'narration', 'transaction', 'item'],
  category: ['category', 'expensecategory', 'type'],
  amount: ['amount', 'total', 'value', 'debit', 'spent'],
  currency: ['currency', 'curr'],
  vendor: ['vendor', 'supplier', 'payee', 'merchant'],
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

function mapCategory(value: unknown): ImportCategory {
  const text = valueText(value).toLowerCase()
  return IMPORT_CATEGORIES.find((category) => text.includes(category)) ?? 'other'
}

function mapCostCentre(value: unknown): CostCentreCode | '' {
  const text = valueText(value).trim().toLowerCase()
  const code = COST_CENTRE_CODES.find((item) => item.toLowerCase() === text)
  if (code) return code
  const centre = COST_CENTRES.find((item) => text && (item.name.toLowerCase().includes(text) || text.includes(item.name.toLowerCase())))
  return centre?.code ?? ''
}

function normalizeRow(rowNumber: number, source: Record<string, unknown>): FinanceImportRow {
  const amount = parseAmount(source.amount)
  const expenseDate = parseDate(source.expenseDate)
  const description = valueText(source.description).slice(0, 500)
  const costCentreCode = mapCostCentre(source.costCentreCode)
  const issues: string[] = []
  if (!expenseDate) issues.push('A valid date is required')
  if (!description) issues.push('A description is required')
  if (!Number.isInteger(amount) || amount < 0) issues.push('Amount must be a non-negative whole number')
  if (!costCentreCode) issues.push('Choose a cost centre')
  return {
    rowNumber,
    included: true,
    expenseDate,
    description,
    category: mapCategory(source.category),
    amount: Number.isFinite(amount) ? amount : 0,
    currency: valueText(source.currency).toUpperCase().slice(0, 10) || 'NGN',
    vendor: valueText(source.vendor).slice(0, 200),
    receiptRef: valueText(source.receiptRef).slice(0, 200),
    costCentreCode,
    issues,
  }
}

function tableToRows(table: unknown[][]): FinanceImportRow[] {
  if (table.length < 2) throw new Error('IMPORT_HAS_NO_DATA_ROWS')
  const headerIndex = table.findIndex((row) => row.map(normalizedHeader).some((cell) => HEADER_ALIASES.amount.includes(cell)))
  if (headerIndex < 0) throw new Error('IMPORT_HEADERS_NOT_FOUND')
  const fields = table[headerIndex]!.map((value) => resolveHeader(normalizedHeader(value)))
  if (!fields.includes('amount') || !fields.includes('expenseDate') || !fields.includes('description')) throw new Error('IMPORT_REQUIRED_HEADERS_MISSING')
  return table.slice(headerIndex + 1, headerIndex + 501).map((values, index) => {
    const source: Record<string, unknown> = {}
    fields.forEach((field, column) => { if (field) source[field] = values[column] })
    return normalizeRow(headerIndex + index + 2, source)
  }).filter((row) => row.description || row.amount)
}

async function spreadsheetRows(buffer: Buffer, extension: string) {
  if (extension === '.csv') return tableToRows(parseCsv(buffer.toString('utf8')))
  const table = await readSheet(buffer)
  return tableToRows(table)
}

async function pdfRows(buffer: Buffer) {
  const text = await extractPdfPlainText(buffer)
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const rows: FinanceImportRow[] = []
  for (let i = 0; i < lines.length && rows.length < 500; i += 1) {
    const line = lines[i]!
    const match = line.match(/(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})\s+(.+?)\s+(?:NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)$/i)
    if (!match) continue
    rows.push(normalizeRow(i + 1, { expenseDate: match[1], description: match[2], amount: match[3] }))
  }
  if (!rows.length) throw new Error('PDF_TRANSACTIONS_NOT_DETECTED')
  return rows
}

export async function previewFinanceImport(filename: string, buffer: Buffer) {
  const extension = filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? ''
  if (!['.xlsx', '.csv', '.pdf'].includes(extension)) throw new Error('UNSUPPORTED_IMPORT_FILE')
  if (extension === '.xlsx' && !buffer.subarray(0, 2).equals(Buffer.from('PK'))) throw new Error('IMPORT_FILE_TYPE_MISMATCH')
  if (extension === '.pdf' && buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('IMPORT_FILE_TYPE_MISMATCH')
  if (extension === '.csv' && buffer.includes(0)) throw new Error('IMPORT_FILE_TYPE_MISMATCH')
  const rows = extension === '.pdf' ? await pdfRows(buffer) : await spreadsheetRows(buffer, extension)
  if (!rows.length) throw new Error('IMPORT_HAS_NO_DATA_ROWS')
  return { rows, fileHash: createHash('sha256').update(buffer).digest('hex') }
}

export function financeImportFingerprint(fileHash: string, row: Omit<FinanceImportRow, 'issues'>) {
  return createHash('sha256').update(JSON.stringify({ fileHash, row })).digest('hex')
}
