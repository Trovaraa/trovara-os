import { createHash, randomBytes } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { extname, join } from 'node:path'
import mammoth from 'mammoth'
import { extractPdfPlainText } from './invoice-extract.js'
import { getEvidenceStorageRoot } from './evidence-store.js'
import {
  deleteKnowledgeObject,
  getKnowledgeObject,
  knowledgeStorageBucket,
  putKnowledgeObject,
} from './knowledge-storage.js'

export const MAX_KNOWLEDGE_DOCUMENT_BYTES = 10 * 1024 * 1024
const MAX_EXTRACTED_CHARS = 250_000

export type ExtractedKnowledgeDocument = {
  text: string
  mimeType: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  warnings: string[]
}

function documentExtension(filename: string): 'pdf' | 'docx' | null {
  const extension = extname(filename).toLowerCase()
  if (extension === '.pdf') return 'pdf'
  if (extension === '.docx') return 'docx'
  return null
}

export function inspectKnowledgeDocument(buffer: Buffer, filename: string): {
  extension: 'pdf' | 'docx'
  mimeType: ExtractedKnowledgeDocument['mimeType']
} {
  if (!buffer.length) throw new Error('The selected document is empty')
  if (buffer.length > MAX_KNOWLEDGE_DOCUMENT_BYTES) throw new Error('Document is larger than 10 MB')
  const extension = documentExtension(filename)
  if (!extension) throw new Error('Only PDF and DOCX documents are supported')
  if (extension === 'pdf' && buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('The file extension says PDF, but the file is not a valid PDF')
  }
  if (extension === 'docx' && (buffer[0] !== 0x50 || buffer[1] !== 0x4b)) {
    throw new Error('The file extension says DOCX, but the file is not a valid DOCX')
  }
  return {
    extension,
    mimeType: extension === 'pdf'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }
}

function normalizeExtractedText(value: string): string {
  return value
    .split(String.fromCharCode(0))
    .join('')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

export async function extractKnowledgeDocument(
  buffer: Buffer,
  filename: string,
): Promise<ExtractedKnowledgeDocument> {
  const inspected = inspectKnowledgeDocument(buffer, filename)
  const { extension } = inspected

  let raw = ''
  let mimeType: ExtractedKnowledgeDocument['mimeType']
  const warnings: string[] = []
  if (extension === 'pdf') {
    mimeType = 'application/pdf'
    raw = await extractPdfPlainText(buffer)
    if (!raw.trim()) {
      warnings.push('No selectable text was found. Scanned PDFs need OCR before they can be imported.')
    }
  } else {
    mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    const result = await mammoth.extractRawText({ buffer })
    raw = result.value
    warnings.push(...result.messages.map((message) => message.message).filter(Boolean).slice(0, 10))
  }

  let text = normalizeExtractedText(raw)
  if (text.length > MAX_EXTRACTED_CHARS) {
    text = text.slice(0, MAX_EXTRACTED_CHARS)
    warnings.push('The extracted text was shortened to 250,000 characters for review.')
  }
  if (text.length < 20) {
    throw new Error(warnings[0] ?? 'The document does not contain enough readable text')
  }
  return { text, mimeType, warnings }
}

function safeStorageKey(storageKey: string): boolean {
  return /^[a-zA-Z0-9_-]+\.(pdf|docx)$/.test(storageKey)
}

function documentPath(farmId: string, storageKey: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(farmId) || !safeStorageKey(storageKey)) {
    throw new Error('Invalid knowledge document path')
  }
  return join(getEvidenceStorageRoot(), '_knowledge', farmId, storageKey)
}

function assertObjectFarmScope(farmId: string, storageKey: string) {
  const segments = storageKey.split('/')
  if (segments.length !== 3 || segments[1] !== farmId) {
    throw new Error('Knowledge document does not belong to this farm storage scope')
  }
}

export async function storeKnowledgeDocument(
  farmId: string,
  filename: string,
  buffer: Buffer,
): Promise<{ storageKey: string; storageBucket: string | null; sha256: string }> {
  const inspected = inspectKnowledgeDocument(buffer, filename)
  if (!/^[a-zA-Z0-9_-]+$/.test(farmId)) throw new Error('Invalid farm storage scope')
  const storageKey = `quarantine/${farmId}/${randomBytes(18).toString('base64url')}.${inspected.extension}`
  await putKnowledgeObject(storageKey, buffer, inspected.mimeType)
  return {
    storageKey,
    storageBucket: knowledgeStorageBucket(),
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

export async function readKnowledgeDocument(farmId: string, storageKey: string): Promise<Buffer> {
  if (storageKey.includes('/')) {
    assertObjectFarmScope(farmId, storageKey)
    return getKnowledgeObject(storageKey)
  }
  return readFile(documentPath(farmId, storageKey))
}

export async function deleteKnowledgeDocument(farmId: string, storageKey: string): Promise<void> {
  if (storageKey.includes('/')) {
    assertObjectFarmScope(farmId, storageKey)
    return deleteKnowledgeObject(storageKey)
  }
  try {
    await unlink(documentPath(farmId, storageKey))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export type KnowledgeChunkDraft = { chunkIndex: number; heading: string | null; content: string }

/** Split reviewed guideline text into stable, overlapping chunks for semantic retrieval. */
export function splitGuidelineIntoChunks(body: string, targetChars = 1_200): KnowledgeChunkDraft[] {
  const paragraphs = normalizeExtractedText(body).split(/\n{2,}/).filter(Boolean)
  const chunks: KnowledgeChunkDraft[] = []
  let current = ''
  let heading: string | null = null

  const flush = () => {
    const content = current.trim()
    if (!content) return
    chunks.push({ chunkIndex: chunks.length, heading, content })
    const overlap = content.slice(-180)
    current = overlap.includes(' ') ? overlap.slice(overlap.indexOf(' ') + 1) : ''
  }

  for (const paragraph of paragraphs) {
    const looksLikeHeading = paragraph.length <= 100 && !/[.!?]$/.test(paragraph)
    if (looksLikeHeading) heading = paragraph
    if (current && current.length + paragraph.length + 2 > targetChars) flush()
    current += `${current ? '\n\n' : ''}${paragraph}`
    while (current.length > targetChars * 1.6) {
      const cutAt = current.lastIndexOf(' ', targetChars)
      const cut = cutAt > targetChars * 0.6 ? cutAt : targetChars
      const rest = current.slice(cut).trim()
      current = current.slice(0, cut)
      flush()
      current += rest
    }
  }
  flush()
  return chunks
}
