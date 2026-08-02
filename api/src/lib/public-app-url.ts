/**
 * Public SPA origin for buyer-facing lot / reset / share links.
 * Production defaults to os.trovara.farm; local dev defaults to the Vite OS app.
 */
export function publicAppBaseUrl(): string {
  const configured = process.env.PUBLIC_APP_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  if (process.env.NODE_ENV === 'production') return 'https://os.trovara.farm'
  return 'http://127.0.0.1:5173'
}
