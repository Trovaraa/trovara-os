import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function estimateConfidence(text: string) {
  if (!text.trim()) return 0
  const visible = [...text].filter((character) => !/\s/.test(character))
  const readable = visible.filter((character) => /[\p{L}\p{N}.,;:'"!?()/%+-]/u.test(character))
  const replacementPenalty = (text.match(/�/g)?.length ?? 0) * 4
  return Math.max(0, Math.min(95, Math.round((readable.length / Math.max(visible.length, 1)) * 100 - replacementPenalty)))
}

export async function ocrPdf(buffer: Buffer): Promise<{ pdf: Buffer; text: string; confidence: number }> {
  const work = await mkdtemp(join(tmpdir(), 'trovara-ocr-'))
  const input = join(work, 'input.pdf')
  const output = join(work, 'output.pdf')
  const sidecar = join(work, 'output.txt')
  try {
    await writeFile(input, buffer)
    await execFileAsync(process.env.OCR_COMMAND?.trim() || 'ocrmypdf', [
      '--skip-text',
      '--rotate-pages',
      '--deskew',
      '--optimize', '1',
      '--language', process.env.OCR_LANGUAGES?.trim() || 'eng+fra',
      '--sidecar', sidecar,
      input,
      output,
    ], { timeout: Number(process.env.OCR_TIMEOUT_MS || 300_000), maxBuffer: 5 * 1024 * 1024 })
    const [pdf, text] = await Promise.all([readFile(output), readFile(sidecar, 'utf8')])
    return { pdf, text: text.trim(), confidence: estimateConfidence(text) }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
