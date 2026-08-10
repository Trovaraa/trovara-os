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
 * Canonical browser origin for the marketing site.
 * Apex `trovara.farm` is normalized to `www` (Netlify primary + PWA scope).
 */
export function normalizeMarketingOrigin(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/^https?:\/\/trovara\.farm$/i, 'https://www.trovara.farm')
}

/**
 * Marketing site origin (trovara.farm) when configured.
 * Used for shop account links and branded public lot pages.
 */
export function publicMarketingBaseUrl(): string | null {
  const configured = process.env.PUBLIC_MARKETING_URL?.trim()
  if (!configured) return null
  return normalizeMarketingOrigin(configured)
}

/** Shop / newsletter email links — configured origin or www marketing default. */
export function publicMarketingUrlOrDefault(): string {
  return publicMarketingBaseUrl() ?? 'https://www.trovara.farm'
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

/** Absolute public brand pack page URL (`/brand/:token`). */
export function publicBrandPackUrl(shareToken: string): string {
  return `${publicMarketingUrlOrDefault()}/brand/${shareToken}`
}
