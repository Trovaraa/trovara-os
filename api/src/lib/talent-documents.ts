import { createHash, randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { simpleParser } from 'mailparser'
import { inspectKnowledgeDocument, extractKnowledgeDocument } from './knowledge-documents.js'
import { assertBufferIsClean } from './malware-scan.js'
import { ocrPdf } from './knowledge-ocr.js'
import { putKnowledgeObject, deleteKnowledgeObject } from './knowledge-storage.js'

export const TALENT_FILE_LIMIT = 10 * 1024 * 1024
export const TALENT_STAGES = ['new', 'reviewing', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'] as const
export const TALENT_NOTICE_VERSION = 'talent-2026-09-13'
export const TALENT_MAILBOX = 'hello@trovara.farm'
export const TALENT_PRIVACY_NOTICE = 'Trovara uses your contact details, CV and supporting documents to assess your application and contact you about recruitment. Access is restricted to authorised hiring staff. Records are normally kept for 180 days from receipt or import; any justified extension is recorded. Contact hello@trovara.farm to request access, correction, withdrawal or deletion. CV text extraction assists human review; it does not make hiring decisions. Please do not include identity numbers, bank details or other unnecessary sensitive information.'

export function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function safeTalentFilename(value: string): string {
  return value.split(/[\\/]/).pop()!.replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(-180) || 'document.pdf'
}

export async function inspectTalentCv(buffer: Buffer, filename: string) {
  const inspected = inspectKnowledgeDocument(buffer, filename)
  if (inspected.extension === 'docx') {
    const zip = await JSZip.loadAsync(buffer)
    const files = Object.values(zip.files)
    if (files.length > 500 || !zip.file('word/document.xml') || zip.file('word/vbaProject.bin')) {
      throw new Error('Unsupported Word document. Upload a standard PDF or DOCX CV.')
    }
    // Check central-directory lengths before Mammoth decompresses any document content.
    const size = files.reduce((total, entry) => total + Number(
      (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
    ), 0)
    if (!Number.isFinite(size) || size > 30 * 1024 * 1024) throw new Error('Expanded Word document exceeds 30 MB')
  }
  return inspected
}

export type PreparedTalentDocument = {
  filename: string
  mimeType: string
  storageKey: string
  sha256: string
  kind: 'cv' | 'supporting' | 'email'
  extractionStatus: 'pending' | 'not_applicable'
}

export async function prepareTalentDocument(farmId: string, filename: string, buffer: Buffer, kind: PreparedTalentDocument['kind']): Promise<PreparedTalentDocument> {
  if (!/^[a-f0-9-]{36}$/i.test(farmId)) throw new Error('Invalid farm')
  if (!buffer.length || buffer.length > TALENT_FILE_LIMIT) throw new Error('Each file must be between 1 byte and 10 MB')
  const inspected = kind === 'email' ? { mimeType: 'message/rfc822', extension: 'eml' } : await inspectTalentCv(buffer, filename)
  await assertBufferIsClean(buffer)
  // Use the encrypted private store, outside quarantine's automatic 14-day expiry.
  const storageKey = `clean/${farmId}/talent-${randomUUID()}.${inspected.extension}`
  await putKnowledgeObject(storageKey, buffer, inspected.mimeType)
  return {
    filename: safeTalentFilename(filename), mimeType: inspected.mimeType, storageKey,
    sha256: digest(buffer), kind, extractionStatus: kind === 'email' ? 'not_applicable' : 'pending',
  }
}

export async function discardPreparedDocuments(documents: PreparedTalentDocument[]) {
  for (const document of documents) await deleteKnowledgeObject(document.storageKey)
}

const headings: Record<string, RegExp> = {
  summary: /^(?:professional |personal |career )?(?:summary|profile|objective)$/i,
  experience: /^(?:(?:work|professional|employment|relevant) )?(?:experience|history)$/i,
  education: /^(?:education(?:al)?(?: background| qualifications)?|academic qualifications)$/i,
  skills: /^(?:(?:technical|key|core) )?(?:skills|competencies)$/i,
  certifications: /^(?:certifications?|certificates?|training|professional qualifications)$/i,
  languages: /^languages?(?: spoken)?$/i,
}

/** Suggestions only. Preserve the source; never infer missing qualifications or sensitive traits. */
export function extractTalentFields(text: string): Record<string, string | null> {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, '').trim()).filter(Boolean)
  const email = text.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() ?? null
  const nameLine = lines.find((line) => /^(?:full )?name\s*:/i.test(line))
  const possibleName = lines.slice(0, 5).find((line) =>
    /^[\p{L}][\p{L}'’-]+(?:[ \t]+[\p{L}][\p{L}'’-]+){1,4}$/u.test(line) &&
    !/curriculum|vitae|resume|profile|summary|supervisor|manager|engineer|experience|education/i.test(line),
  )
  const phoneLine = lines.find((line) => /(?:phone|mobile|telephone|tel)\s*[:.]/i.test(line))
  const phone = (phoneLine ?? text).match(/(?:\+\d{1,3}[ ()-]*)?(?:\d[ ()-]*){10,14}\d/)?.[0]?.trim() ?? null
  const location = lines.find((line) => /^(?:location|address|based in)\s*:/i.test(line))?.replace(/^[^:]+:\s*/, '').slice(0, 300) ?? null
  const fields: Record<string, string | null> = {
    name: nameLine?.replace(/^[^:]+:\s*/, '').slice(0, 200) ?? possibleName ?? null,
    email, phone, location, summary: null, experience: null, education: null, skills: null, certifications: null, languages: null,
  }
  let section: string | null = null
  for (const line of lines) {
    const clean = line.replace(/:$/, '').trim()
    const match = Object.entries(headings).find(([, pattern]) => pattern.test(clean))
    if (match) { section = match[0]; continue }
    if (/^(?:references?|hobbies|personal details|interests|referees)\s*:?$/i.test(line)) { section = null; continue }
    if (section) fields[section] = `${fields[section] ?? ''}${fields[section] ? '\n' : ''}${line}`.slice(0, 12_000)
  }
  return fields
}

export async function extractTalentCv(buffer: Buffer, filename: string) {
  const inspected = await inspectTalentCv(buffer, filename)
  let text: string
  let warnings: string[] = []
  try {
    const result = await extractKnowledgeDocument(buffer, filename)
    text = result.text
    warnings = result.warnings
  } catch (error) {
    if (inspected.extension !== 'pdf') throw error
    const ocr = await ocrPdf(buffer)
    text = ocr.text.slice(0, 250_000)
    warnings.push('OCR was used. Check the extracted text against the original CV.')
  }
  if (text.trim().length < 20) throw new Error('No readable CV text. Enter details manually or upload a clearer PDF/DOCX.')
  warnings.push('Extracted fields are suggestions, not verified facts. Confirm them against the CV. Unrecognised sections remain in the full text.')
  return { text, fields: extractTalentFields(text), warnings }
}

export async function parseTalentEmail(buffer: Buffer) {
  if (!buffer.length || buffer.length > TALENT_FILE_LIMIT) throw new Error('Email must be smaller than 10 MB')
  await assertBufferIsClean(buffer)
  const mail = await simpleParser(buffer, { skipImageLinks: true, skipTextToHtml: true })
  const sender = mail.from?.value[0]
  if (!sender?.address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender.address)) throw new Error('Email has no valid sender')
  if (mail.attachments.length > 20) throw new Error('Email has too many attachments (maximum 20)')
  const subject = (mail.subject ?? 'Application').slice(0, 300)
  return {
    name: sender.name || sender.address, email: sender.address.toLowerCase(),
    subject, body: (mail.text ?? '').slice(0, 100_000),
    applicationReference: subject.match(/\[Trovara ([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\]/i)?.[1]?.toLowerCase(),
    receivedAt: mail.date && Number.isFinite(mail.date.getTime()) ? mail.date : new Date(),
    messageKey: digest(mail.messageId?.trim() || buffer),
    references: [...(mail.references ?? []), ...(mail.inReplyTo ? [mail.inReplyTo] : [])].map(digest),
    // Subject alone is NOT an identity: unrelated submissions must not be merged automatically.
    attachments: mail.attachments,
  }
}
