import { describe, expect, it, vi } from 'vitest'
import { extractKnowledgeDocument, readKnowledgeDocument, splitGuidelineIntoChunks } from './knowledge-documents.js'

vi.mock('mammoth', () => ({
  default: {
    convertToHtml: async () => ({
      value: '<p>Why Poultry.</p><table><tr><td>Enterprise</td><td>Poultry</td></tr><tr><td>First Revenue</td><td>8-12 weeks</td></tr></table>',
      messages: [],
    }),
  },
}))

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

  it('keeps a markdown table in one retrieval chunk', () => {
    const table = [
      '| Enterprise | Poultry | Goats |',
      '| --- | --- | --- |',
      '| First Revenue | 8–12 weeks | 12–18 months |',
      '| Scalability | Excellent | High |',
    ].join('\n')
    const chunks = splitGuidelineIntoChunks(`Why poultry\n\n${table}\n\nNext steps for the farm team.`, 80)
    expect(chunks.some((chunk) => chunk.content.includes('| Enterprise | Poultry | Goats |') && chunk.content.includes('| Scalability | Excellent | High |'))).toBe(true)
  })

  it('rejects a renamed file whose signature is not a PDF', async () => {
    await expect(extractKnowledgeDocument(Buffer.from('not a pdf'), 'guide.pdf')).rejects.toThrow(
      /not a valid PDF/,
    )
  })

  it('extracts Word tables as markdown tables', async () => {
    const extracted = await extractKnowledgeDocument(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), 'brief.docx')
    expect(extracted.text).toContain('Why Poultry.')
    expect(extracted.text).toContain('| Enterprise | Poultry |')
    expect(extracted.text).toContain('| --- | --- |')
    expect(extracted.warnings.some((warning) => /tables were kept/i.test(warning))).toBe(true)
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
