/**
 * Public SPA origin for buyer-facing reset / share links that stay on OS.
 * Production defaults to os.trovara.farm; local dev defaults to the Vite OS app.
 */
export function publicAppBaseUrl(): string {
  const configured = process.env.PUBLIC_APP_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  if (process.env.NODE_ENV === 'production') return 'https://os.trovara.farm'
  return 'http://127.0.0.1:5173'
}

/**
 * Marketing site origin (trovara.farm) when configured.
 * Used for shop account links and branded public lot pages.
 */
export function publicMarketingBaseUrl(): string | null {
  const configured = process.env.PUBLIC_MARKETING_URL?.trim()
  if (!configured) return null
  return configured.replace(/\/+$/, '')
}

/**
 * Buyer-facing lot page origin: prefer the marketing site when
 * PUBLIC_MARKETING_URL is set so QR/share links open on brand UI.
 * Falls back to the OS SPA origin.
 */
export function publicLotPageBaseUrl(): string {
  return publicMarketingBaseUrl() ?? publicAppBaseUrl()
}

/** Absolute public lot page URL (`/lot/:farmSlug/:token`). */
export function publicLotPageUrl(farmSlug: string | null | undefined, publicToken: string): string {
  return `${publicLotPageBaseUrl()}/lot/${farmSlug ?? 'farm'}/${publicToken}`
}
