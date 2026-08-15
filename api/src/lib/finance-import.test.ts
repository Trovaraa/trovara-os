import { describe, expect, it } from 'vitest'
import {
  createFinanceImportToken,
  financeImportFingerprint,
  previewFinanceImport,
  verifyFinanceImportToken,
} from './finance-import.js'

describe('finance transaction imports', () => {
  it('normalizes CSV rows and flags a missing cost centre before commit', async () => {
    const csv = [
      'Date,Description,Amount,Category,Cost Centre,Vendor',
      '15/08/2026,Poultry feed,125000,feed,CC30,Ade Supplies',
      '14/08/2026,Fuel,45000,transport,,Fuel Station',
    ].join('\n')
    const preview = await previewFinanceImport('history.csv', Buffer.from(csv))
    expect(preview.rows).toHaveLength(2)
    expect(preview.rows[0]).toMatchObject({ amount: 125000, category: 'feed', costCentreCode: 'CC30', issues: [] })
    expect(preview.rows[1]?.issues).toContain('Choose a cost centre')
  })

  it('binds a short-lived preview token to the farm and user', () => {
    const token = createFinanceImportToken({ farmId: 'farm-1', userId: 'user-1', filename: 'history.csv', fileHash: 'abc' })
    expect(verifyFinanceImportToken(token, 'farm-1', 'user-1')).toMatchObject({ filename: 'history.csv', fileHash: 'abc' })
    expect(() => verifyFinanceImportToken(token, 'farm-2', 'user-1')).toThrow('INVALID_IMPORT_TOKEN')
  })

  it('creates stable duplicate fingerprints', () => {
    const row = { rowNumber: 2, included: true, expenseDate: '2026-08-15T12:00:00.000Z', description: 'Feed', category: 'feed' as const, amount: 100, currency: 'NGN', vendor: '', receiptRef: '', costCentreCode: 'CC30' as const }
    expect(financeImportFingerprint('hash', row)).toBe(financeImportFingerprint('hash', row))
    expect(financeImportFingerprint('hash-2', row)).not.toBe(financeImportFingerprint('hash', row))
  })
})
