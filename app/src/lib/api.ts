const base = import.meta.env.VITE_API_URL ?? ''

function getCsrfToken(): string | undefined {
  const match = document.cookie.match(/(?:^|;\s*)trovara_csrf=([^;]+)/)
  return match?.[1]
}

/** Turn API / Zod error payloads into a readable string (avoid "[object Object]"). */
function messageFromErrorBody(body: unknown, status: number): string {
  if (!body || typeof body !== 'object') return `Request failed (${status})`
  const record = body as Record<string, unknown>
  const err = record.error ?? record.message

  if (typeof err === 'string' && err.trim()) return err

  if (err && typeof err === 'object') {
    const issues = (err as { issues?: unknown }).issues
    if (Array.isArray(issues) && issues.length > 0) {
      return issues
        .map((issue) => {
          if (!issue || typeof issue !== 'object') return String(issue)
          const item = issue as { path?: unknown; message?: unknown }
          const path = Array.isArray(item.path) ? item.path.join('.') : ''
          const msg = typeof item.message === 'string' ? item.message : 'Invalid value'
          return path ? `${path}: ${msg}` : msg
        })
        .join('; ')
    }
    if (typeof (err as { message?: unknown }).message === 'string') {
      return (err as { message: string }).message
    }
  }

  if (typeof record.message === 'string' && record.message.trim()) return record.message
  return `Request failed (${status})`
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  }

  if (['POST', 'PATCH', 'DELETE'].includes(method)) {
    const csrf = getCsrfToken()
    if (csrf) headers['X-CSRF-Token'] = csrf
  }

  const res = await fetch(`${base}${path}`, {
    ...options,
    credentials: 'include',
    headers,
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: unknown
      message?: unknown
      code?: unknown
    }
    const err = new Error(messageFromErrorBody(body, res.status)) as Error & { code?: string }
    if (typeof body.code === 'string' && body.code.trim()) err.code = body.code
    throw err
  }

  // A stale service worker or cache can serve the app shell (HTML) for an API call,
  // which then fails JSON parsing with a cryptic "Unexpected token '<'". Detect it.
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new Error(
      'Unexpected non-JSON response from the server. A stale cache or service worker may be intercepting requests - hard refresh (Cmd/Ctrl+Shift+R) and try again.',
    )
  }

  return res.json() as Promise<T>
}
