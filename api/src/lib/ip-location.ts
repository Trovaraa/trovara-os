/**
 * Offline IP → approximate location for security / audit displays.
 * Uses the bundled geoip-lite database (city-level when available).
 */
import geoip from 'geoip-lite'

export type IpLocation = {
  countryCode: string
  /** Display country name when available (e.g. Netherlands). */
  country: string
  /** City or subdivision label when available (e.g. Rotterdam). */
  region?: string
}

const countryDisplay = new Intl.DisplayNames(['en'], { type: 'region' })

export function countryCodeToName(code: string | undefined): string | undefined {
  const normalized = code?.trim().toUpperCase()
  if (!normalized || normalized.length !== 2) return undefined
  try {
    return countryDisplay.of(normalized) ?? undefined
  } catch {
    return undefined
  }
}

export function isNonPublicIp(ip: string): boolean {
  const value = ip.trim().toLowerCase()
  if (!value || value === 'unknown' || value === '127.0.0.1' || value === '::1') return true
  if (value.startsWith('10.') || value.startsWith('192.168.') || value.startsWith('169.254.')) {
    return true
  }
  const m = /^172\.(\d+)\./.exec(value)
  if (m) {
    const octet = Number(m[1])
    if (octet >= 16 && octet <= 31) return true
  }
  return false
}

export function lookupIpLocation(ip: string | undefined): IpLocation | null {
  if (!ip || isNonPublicIp(ip)) return null
  const hit = geoip.lookup(ip.trim())
  if (!hit?.country) return null
  const country = countryCodeToName(hit.country) ?? hit.country
  const region = hit.city?.trim() || hit.region?.trim() || undefined
  return {
    countryCode: hit.country,
    country,
    ...(region ? { region } : {}),
  }
}

/** Fill missing country/region on security metadata from the IP when possible. */
export function enrichAccessLocation(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const ip = typeof metadata.ip === 'string' ? metadata.ip : ''
  const existingCountry = typeof metadata.country === 'string' ? metadata.country.trim() : ''
  const existingRegion = typeof metadata.region === 'string' ? metadata.region.trim() : ''

  const looked = lookupIpLocation(ip)
  let country = existingCountry
  let region = existingRegion

  if (country && country.length === 2) {
    country = countryCodeToName(country) ?? country.toUpperCase()
  }
  if (!country && looked) country = looked.country
  if (!region && looked?.region) region = looked.region

  return {
    ...metadata,
    ...(country ? { country } : {}),
    ...(region ? { region } : {}),
  }
}
