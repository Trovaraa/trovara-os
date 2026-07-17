import { afterEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  deleteEvidenceByUrl,
  getEvidenceStorageRoot,
  parseEvidenceStorageUrl,
  readEvidenceFile,
  storeEvidenceFromDataUrl,
} from './evidence-store.js'

const farmId = `evidence-test-${process.pid}`

afterEach(async () => {
  await rm(join(getEvidenceStorageRoot(), farmId), { recursive: true, force: true })
})

describe('private evidence storage', () => {
  it('stores, reads, and deletes an authorized evidence reference', async () => {
    const value = 'data:image/png;base64,aGVsbG8='
    const url = await storeEvidenceFromDataUrl(farmId, value)
    const parsed = parseEvidenceStorageUrl(url)

    expect(parsed?.farmId).toBe(farmId)
    const stored = await readEvidenceFile(parsed!.farmId, parsed!.filename)
    expect(stored.contentType).toBe('image/png')
    expect(stored.buffer.toString('utf8')).toBe('hello')

    await expect(deleteEvidenceByUrl(url)).resolves.toBe(true)
    await expect(readEvidenceFile(parsed!.farmId, parsed!.filename)).rejects.toThrow()
  })

  it('rejects path traversal in evidence references', () => {
    expect(parseEvidenceStorageUrl('/api/evidence/../secret.png')).toBeNull()
    expect(parseEvidenceStorageUrl('/api/evidence/farm/../../secret.png')).toBeNull()
  })
})
