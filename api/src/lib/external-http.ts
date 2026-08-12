export type ExternalFetchOptions = {
  timeoutMs?: number
  retries?: number
  retryUnsafe?: boolean
  retryBaseMs?: number
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value?.trim() || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function retryDelay(response: Response | null, attempt: number, baseMs: number): number {
  const retryAfter = response?.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000)
    const at = Date.parse(retryAfter)
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), 10_000)
  }
  return Math.min(baseMs * 2 ** attempt, 2_000)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fetch with a hard per-attempt deadline and bounded retry. Unsafe methods are
 * not retried unless the caller confirms the provider request is idempotent.
 */
export async function externalFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: ExternalFetchOptions = {},
): Promise<Response> {
  const timeoutMs =
    options.timeoutMs ??
    positiveInt(process.env.EXTERNAL_HTTP_TIMEOUT_MS, 10_000)
  const retries =
    options.retries ??
    positiveInt(process.env.EXTERNAL_HTTP_MAX_ATTEMPTS, 2) - 1
  const retryBaseMs = options.retryBaseMs ?? 150
  const method = (init.method ?? 'GET').toUpperCase()
  const mayRetry = SAFE_METHODS.has(method) || options.retryUnsafe === true
  let lastError: unknown

  for (let attempt = 0; attempt <= Math.max(0, retries); attempt += 1) {
    const controller = new AbortController()
    const relayAbort = () => controller.abort(init.signal?.reason)
    init.signal?.addEventListener('abort', relayAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error(`deadline exceeded after ${timeoutMs}ms`)), timeoutMs)
    let response: Response | null = null
    try {
      response = await fetch(input, { ...init, signal: controller.signal })
      if (!mayRetry || !RETRYABLE_STATUS.has(response.status) || attempt >= retries) {
        return response
      }
      await response.body?.cancel().catch(() => undefined)
    } catch (error) {
      lastError = error
      if (!mayRetry || attempt >= retries || init.signal?.aborted) throw error
    } finally {
      clearTimeout(timer)
      init.signal?.removeEventListener('abort', relayAbort)
    }
    await sleep(retryDelay(response, attempt, retryBaseMs))
  }

  throw lastError instanceof Error ? lastError : new Error('External request failed')
}

/** Deadline/retry adapter for SDKs that do not expose their underlying fetch. */
export async function externalOperation<T>(
  operation: () => Promise<T>,
  options: Pick<ExternalFetchOptions, 'timeoutMs' | 'retries' | 'retryBaseMs'> = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? positiveInt(process.env.EXTERNAL_HTTP_TIMEOUT_MS, 10_000)
  const retries = options.retries ?? positiveInt(process.env.EXTERNAL_HTTP_MAX_ATTEMPTS, 2) - 1
  let lastError: unknown
  for (let attempt = 0; attempt <= Math.max(0, retries); attempt += 1) {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`external operation deadline exceeded after ${timeoutMs}ms`)),
            timeoutMs,
          )
        }),
      ])
    } catch (error) {
      lastError = error
      if (attempt >= retries) throw error
      await sleep(Math.min((options.retryBaseMs ?? 150) * 2 ** attempt, 2_000))
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('External operation failed')
}
