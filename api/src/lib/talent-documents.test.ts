import { beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { extractTalentFields, inspectTalentCv, parseTalentEmail, safeTalentFilename, TALENT_FILE_LIMIT } from './talent-documents.js'

vi.mock('./malware-scan.js', () => ({ assertBufferIsClean: vi.fn() }))
vi.mock('./knowledge-storage.js', () => ({ putKnowledgeObject: vi.fn(), deleteKnowledgeObject: vi.fn() }))
const { assertBufferIsClean } = await import('./malware-scan.js')

describe('Talent CV extraction and input boundaries', () => {
  beforeEach(() => vi.clearAllMocks())
  it('extracts source-backed contacts and named sections without inferring missing fields', () => {
    const fields = extractTalentFields('Full name: Ada Example\nEmail: ada@example.com\nPhone: +234 801 234 5678\nLocation: Abeokuta\nEducation\nBSc Botany, Example University\nWork Experience\nFarm assistant, 2022–2025\nSkills\nNursery management\nReferences\nSomeone else')
    expect(fields).toMatchObject({ name: 'Ada Example', email: 'ada@example.com', location: 'Abeokuta',
      education: 'BSc Botany, Example University', experience: 'Farm assistant, 2022–2025', skills: 'Nursery management', languages: null })
  })
  it('does not invent absent contact details or a name from a CV heading', () => {
    expect(extractTalentFields('CURRICULUM VITAE\nEducation\nBSc')).toMatchObject({ name: null, email: null, phone: null, location: null })
  })
  it('sanitises path and header characters from filenames', () => {
    expect(safeTalentFilename('../../cv\r\nmalicious.pdf')).toBe('cv__malicious.pdf')
    expect(safeTalentFilename('C:\\private\\cv.docx')).toBe('cv.docx')
  })
  it('rejects wrong types, mismatched signatures and oversized CVs', async () => {
    await expect(inspectTalentCv(Buffer.from('hello'), 'cv.exe')).rejects.toThrow('Only PDF')
    await expect(inspectTalentCv(Buffer.from('hello'), 'cv.pdf')).rejects.toThrow('not a valid PDF')
    await expect(inspectTalentCv(Buffer.alloc(TALENT_FILE_LIMIT + 1), 'cv.pdf')).rejects.toThrow('10 MB')
  })
  it('rejects arbitrary ZIPs posing as Word documents', async () => {
    const zip = new JSZip(); zip.file('payload.txt', 'not a CV')
    await expect(inspectTalentCv(await zip.generateAsync({ type: 'nodebuffer' }), 'cv.docx')).rejects.toThrow('standard PDF or DOCX')
  })
  it('rejects macro-bearing Word documents', async () => {
    const zip = new JSZip(); zip.file('word/document.xml', '<xml/>'); zip.file('word/vbaProject.bin', 'macro')
    await expect(inspectTalentCv(await zip.generateAsync({ type: 'nodebuffer' }), 'cv.docx')).rejects.toThrow('standard PDF or DOCX')
  })
  it('rejects decompression bombs before extraction', async () => {
    const zip = new JSZip(); zip.file('word/document.xml', 'a'.repeat(31 * 1024 * 1024))
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    await expect(inspectTalentCv(buffer, 'cv.docx')).rejects.toThrow('30 MB')
  })
  it('preserves message IDs, reference chains, dates and text without rendering HTML', async () => {
    const source = Buffer.from('From: Ada Example <ada@example.com>\r\nTo: hello@trovara.farm\r\nMessage-ID: <application@example.com>\r\nIn-Reply-To: <parent@example.com>\r\nDate: Tue, 11 Aug 2026 10:00:00 +0100\r\nSubject: Re: Farm Supervisor\r\nContent-Type: text/plain\r\n\r\nPlease find my CV attached.')
    const mail = await parseTalentEmail(source)
    expect(mail.name).toBe('Ada Example'); expect(mail.email).toBe('ada@example.com')
    expect(mail.body).toContain('CV attached'); expect(mail.references).toHaveLength(1)
    expect(mail.receivedAt.toISOString()).toBe('2026-08-11T09:00:00.000Z')
    expect((await parseTalentEmail(source)).messageKey).toBe(mail.messageKey)
    expect(assertBufferIsClean).toHaveBeenCalled()
  })
  it('rejects email without a sender', async () => {
    await expect(parseTalentEmail(Buffer.from('Subject: Test\r\n\r\nHello'))).rejects.toThrow('sender')
  })
  it('fails closed when malware scanning is unavailable', async () => {
    vi.mocked(assertBufferIsClean).mockRejectedValueOnce(new Error('Scanner offline'))
    await expect(parseTalentEmail(Buffer.from('From: a@example.com\r\n\r\nTest'))).rejects.toThrow('Scanner offline')
  })
})
