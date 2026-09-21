import { describe, expect, it } from 'vitest'
import {
  createFinanceImportToken,
  financeImportFingerprint,
  previewFinanceImport,
  verifyFinanceImportToken,
} from './finance-import.js'

describe('finance transaction imports', () => {
  it.each([
    ['CC02', 'CC02'], ['cc-02', 'CC02'], ['Farm Operations & Shared Services', 'CC02'],
    ['CC03', 'CC03'], ['CC-03', 'CC03'], ['Infrastructure & Utilities', 'CC03'],
    ['CC04', 'CC04'], ['CC-04', 'CC04'], ['Land & Site Development', 'CC04'],
  ])('maps %s to canonical %s without requiring a cost-centre correction', async (input, expected) => {
    const csv = `Date,Description,Amount,Category,Cost Centre\n21/09/2026,Test expense,100,other,${input}`
    const preview = await previewFinanceImport('cost-centres.csv', Buffer.from(csv))
    expect(preview.rows[0]).toMatchObject({ costCentreCode: expected, issues: [] })
  })

  it('leaves an unknown code unassigned for review', async () => {
    const csv = 'Date,Description,Amount,Category,Cost Centre\n21/09/2026,Test expense,100,other,CC-99'
    const preview = await previewFinanceImport('cost-centres.csv', Buffer.from(csv))
    expect(preview.rows[0]).toMatchObject({ costCentreCode: '', issues: ['Choose a cost centre'] })
  })

  it('normalizes CSV rows and flags a missing cost centre before commit', async () => {
    const csv = [
      'SN,Date,Cost description,Amount,Category,Cost Centre,Vendor,Payer,Funding status,Project phase',
      '1,15/08/2026,Poultry feed,125000,feed,CC30,Ade Supplies,Investors,Funded,Farm preparation',
      '2,14/08/2026,Fuel,45000,,,Fuel Station,Bamidele Afolabi,Unfunded,Farm preparation',
    ].join('\n')
    const preview = await previewFinanceImport('history.csv', Buffer.from(csv))
    expect(preview.rows).toHaveLength(2)
    expect(preview.rows[0]).toMatchObject({ sourceRecordId: '1', description: 'Poultry feed', amount: 125000, category: 'feed', entityCode: '002', costCentreCode: 'CC30', payer: 'Investors', fundingStatus: 'Funded', projectPhase: 'Farm preparation', issues: [] })
    expect(preview.rows[1]?.issues).toContain('Choose a cost centre')
    expect(preview.rows[1]?.issues).toContain('Choose an expense category')
  })

  it('binds a short-lived preview token to the farm and user', () => {
    const token = createFinanceImportToken({ farmId: 'farm-1', userId: 'user-1', filename: 'history.csv', fileHash: 'abc', sourceSheets: ['CSV transactions'], formulaRefs: [], expectedTotal: 170000 })
    expect(verifyFinanceImportToken(token, 'farm-1', 'user-1')).toMatchObject({ filename: 'history.csv', fileHash: 'abc', expectedTotal: 170000 })
    expect(() => verifyFinanceImportToken(token, 'farm-2', 'user-1')).toThrow('INVALID_IMPORT_TOKEN')
  })

  it('creates stable duplicate fingerprints', () => {
    const row = { entityCode: '002' as const, expenseDate: '2026-08-15T12:00:00.000Z', description: ' Feed ', amount: 100, currency: 'NGN', vendor: 'Ade Supplies', receiptRef: '' }
    expect(financeImportFingerprint(row)).toBe(financeImportFingerprint({ ...row, description: 'feed' }))
    expect(financeImportFingerprint(row)).not.toBe(financeImportFingerprint({ ...row, amount: 101 }))
    expect(financeImportFingerprint(row)).not.toBe(financeImportFingerprint({ ...row, entityCode: '001' }))
  })
})
