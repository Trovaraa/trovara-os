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
      'SN,Date,Cost description,Amount,Category,Cost Centre,Vendor,Payer,Funding status,Project phase',
      '1,15/08/2026,Poultry feed,125000,feed,CC30,Ade Supplies,Investors,Funded,Farm preparation',
      '2,14/08/2026,Fuel,45000,,,Fuel Station,Bamidele Afolabi,Unfunded,Farm preparation',
    ].join('\n')
    const preview = await previewFinanceImport('history.csv', Buffer.from(csv))
    expect(preview.rows).toHaveLength(2)
    expect(preview.rows[0]).toMatchObject({ sourceRecordId: '1', description: 'Poultry feed', amount: 125000, category: 'feed', costCentreCode: 'CC30', payer: 'Investors', fundingStatus: 'Funded', projectPhase: 'Farm preparation', issues: [] })
    expect(preview.rows[1]?.issues).toContain('Choose a cost centre')
    expect(preview.rows[1]?.issues).toContain('Choose an expense category')
  })

  it('binds a short-lived preview token to the farm and user', () => {
    const token = createFinanceImportToken({ farmId: 'farm-1', userId: 'user-1', filename: 'history.csv', fileHash: 'abc', sourceSheets: ['CSV transactions'], formulaRefs: [], expectedTotal: 170000 })
    expect(verifyFinanceImportToken(token, 'farm-1', 'user-1')).toMatchObject({ filename: 'history.csv', fileHash: 'abc', expectedTotal: 170000 })
    expect(() => verifyFinanceImportToken(token, 'farm-2', 'user-1')).toThrow('INVALID_IMPORT_TOKEN')
  })

  it('creates stable duplicate fingerprints', () => {
    const row = { expenseDate: '2026-08-15T12:00:00.000Z', description: ' Feed ', amount: 100, currency: 'NGN', vendor: 'Ade Supplies', receiptRef: '' }
    expect(financeImportFingerprint(row)).toBe(financeImportFingerprint({ ...row, description: 'feed' }))
    expect(financeImportFingerprint(row)).not.toBe(financeImportFingerprint({ ...row, amount: 101 }))
  })
})
