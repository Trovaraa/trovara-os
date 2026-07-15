const base = import.meta.env.VITE_API_URL ?? ''

function getCsrfToken(): string | undefined {
  const match = document.cookie.match(/(?:^|;\s*)trovara_csrf=([^;]+)/)
  return match?.[1]
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
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`)
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
