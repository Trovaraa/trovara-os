import { describe, expect, it } from 'vitest'
import { extractKnowledgeDocument, readKnowledgeDocument, splitGuidelineIntoChunks } from './knowledge-documents.js'

describe('splitGuidelineIntoChunks', () => {
  it('keeps guideline content in ordered, overlapping retrieval chunks', () => {
    const body = [
      'Poultry biosecurity',
      'Wash hands and disinfect footwear before entering the poultry house. '.repeat(12),
      'Escalation',
      'Report unusual mortality to the supervisor immediately. '.repeat(12),
    ].join('\n\n')
    const chunks = splitGuidelineIntoChunks(body, 420)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index))
    expect(chunks.some((chunk) => chunk.content.includes('disinfect footwear'))).toBe(true)
    expect(chunks.some((chunk) => chunk.content.includes('unusual mortality'))).toBe(true)
  })

  it('rejects a renamed file whose signature is not a PDF', async () => {
    await expect(extractKnowledgeDocument(Buffer.from('not a pdf'), 'guide.pdf')).rejects.toThrow(
      /not a valid PDF/,
    )
  })

  it('rejects unsupported document formats', async () => {
    await expect(extractKnowledgeDocument(Buffer.from('plain text'), 'guide.txt')).rejects.toThrow(
      /Only PDF and DOCX/,
    )
  })

  it('rejects an object key from another farm before reading storage', async () => {
    await expect(readKnowledgeDocument(
      '11111111-1111-1111-1111-111111111111',
      'clean/22222222-2222-2222-2222-222222222222/guide.pdf',
    )).rejects.toThrow(/does not belong/)
  })
})
