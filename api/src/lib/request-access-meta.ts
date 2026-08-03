/**
 * Request access metadata for security / audit logs.
 * Country/region prefer reverse-proxy headers when present
 * (Cloudflare CF-IPCountry / CF-Region, or custom X-Country-Code / X-Region-Code).
 * Otherwise they are approximated offline from the client IP (geoip-lite).
 */
import { clientIpFromHeaders } from './client-ip.js'
import { countryCodeToName, lookupIpLocation } from './ip-location.js'

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
  const headerCountry = cleanCode(
    getHeader('cf-ipcountry') ?? getHeader('x-country-code') ?? getHeader('x-geo-country'),
    8,
  )?.toUpperCase()
  const headerRegion = cleanCode(
    getHeader('cf-region') ??
      getHeader('cf-region-code') ??
      getHeader('x-region-code') ??
      getHeader('x-geo-region'),
    64,
  )

  const looked = !headerCountry || !headerRegion ? lookupIpLocation(ip) : null
  const country =
    (headerCountry ? countryCodeToName(headerCountry) ?? headerCountry : undefined) ??
    looked?.country
  const region = headerRegion ?? looked?.region

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
