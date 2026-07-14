import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const API_LOG_PATH = join(APP_ROOT, 'logs', 'api.log')

type ApiLogMetadata = Record<string, unknown>

export function logApiEvent(type: string, metadata: ApiLogMetadata = {}) {
  try {
    mkdirSync(dirname(API_LOG_PATH), { recursive: true })
    const entry = {
      ts: new Date().toISOString(),
      type,
      metadata,
    }
    appendFileSync(API_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (err) {
    console.error('API log write failed:', err instanceof Error ? err.message : String(err))
  }
}
