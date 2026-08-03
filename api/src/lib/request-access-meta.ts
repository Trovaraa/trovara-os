/**
 * Request access metadata for security / audit logs.
 * Country/region come from reverse-proxy headers when present
 * (Cloudflare CF-IPCountry / CF-Region, or custom X-Country-Code / X-Region-Code).
 * Without those headers, only IP is recorded.
 */
import { clientIpFromHeaders } from './client-ip.js'

export type RequestAccessMeta = {
  ip: string
  country?: string
  region?: string
}

function cleanCode(value: string | undefined, max = 16): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || trimmed === 'XX' || trimmed === 'T1') return undefined
  return trimmed.slice(0, max)
}

export function requestAccessMeta(
  getHeader: (name: string) => string | undefined,
): RequestAccessMeta {
  const ip = clientIpFromHeaders(getHeader)
  const country = cleanCode(
    getHeader('cf-ipcountry') ?? getHeader('x-country-code') ?? getHeader('x-geo-country'),
    8,
  )?.toUpperCase()
  const region = cleanCode(
    getHeader('cf-region') ??
      getHeader('cf-region-code') ??
      getHeader('x-region-code') ??
      getHeader('x-geo-region'),
    64,
  )
  return {
    ip,
    ...(country ? { country } : {}),
    ...(region ? { region } : {}),
  }
}

export function withAccessMeta(
  getHeader: (name: string) => string | undefined,
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...metadata, ...requestAccessMeta(getHeader) }
}
