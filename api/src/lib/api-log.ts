import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { externalFetch } from './external-http.js'

const APP_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const API_LOG_PATH = join(APP_ROOT, 'logs', 'api.log')

type ApiLogMetadata = Record<string, unknown>

export function logApiEvent(type: string, metadata: ApiLogMetadata = {}) {
  const entry = {
    ts: new Date().toISOString(),
    type,
    metadata,
  }
  try {
    mkdirSync(dirname(API_LOG_PATH), { recursive: true })
    appendFileSync(API_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch (err) {
    console.error('API log write failed:', err instanceof Error ? err.message : String(err))
  }

  const drainUrl = process.env.API_LOG_DRAIN_URL?.trim()
  if (drainUrl) {
    const token = process.env.API_LOG_DRAIN_TOKEN?.trim()
    void externalFetch(
      drainUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(entry),
      },
      { timeoutMs: 3_000, retries: 1, retryUnsafe: true },
    ).catch((err) => {
      console.error('API log drain failed:', err instanceof Error ? err.message : String(err))
    })
  }
}
