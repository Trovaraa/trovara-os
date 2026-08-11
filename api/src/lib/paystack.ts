import { createHmac, timingSafeEqual } from 'node:crypto'

const PAYSTACK_BASE = 'https://api.paystack.co'
export const PAYSTACK_REQUEST_TIMEOUT_MS = 10_000

export type PaystackInitializeResult = {
  authorizationUrl: string
  accessCode: string
  reference: string
}

export type PaystackVerifyResult = {
  status: string
  reference: string
  amount: number
  currency: string
  paidAt?: string | null
  gatewayResponse?: string
  metadata?: Record<string, unknown>
  raw: unknown
}

export type PaystackRefundResult = {
  id?: number | string
  status: string
  amount?: number
  currency?: string
  transactionReference?: string
  raw: unknown
}

function secretKey(): string | undefined {
  return process.env.PAYSTACK_SECRET_KEY?.trim() || undefined
}

export function isPaystackConfigured(): boolean {
  return Boolean(secretKey())
}

export function getPaystackPublicKey(): string | undefined {
  return process.env.PAYSTACK_PUBLIC_KEY?.trim() || undefined
}

/** Reconstruct checkout URL from a stored access code (reuse initiated attempts). */
export function authorizationUrlFromAccessCode(accessCode: string): string {
  return `https://checkout.paystack.com/${accessCode}`
}

async function paystackFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: string; status?: number }> {
  const key = secretKey()
  if (!key) return { ok: false, error: 'Paystack is not configured' }

  try {
    const deadline = AbortSignal.timeout(PAYSTACK_REQUEST_TIMEOUT_MS)
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline
    const res = await fetch(`${PAYSTACK_BASE}${path}`, {
      ...init,
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    })
    const body = (await res.json().catch(() => null)) as {
      status?: boolean
      message?: string
      data?: T
    } | null

    if (!res.ok || !body?.status) {
      return {
        ok: false,
        error: body?.message || `Paystack request failed (${res.status})`,
        status: res.status,
      }
    }
    return { ok: true, data: body.data as T }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Paystack request failed',
    }
  }
}

export async function initializeTransaction(params: {
  email: string
  amountKobo: number
  reference: string
  callbackUrl?: string
  metadata?: Record<string, unknown>
}): Promise<{ ok: true; data: PaystackInitializeResult } | { ok: false; error: string }> {
  if (!Number.isFinite(params.amountKobo) || params.amountKobo <= 0) {
    return { ok: false, error: 'Amount must be a positive integer in kobo' }
  }

  const payload: Record<string, unknown> = {
    email: params.email,
    amount: Math.round(params.amountKobo),
    reference: params.reference,
    currency: 'NGN',
  }
  if (params.callbackUrl) payload.callback_url = params.callbackUrl
  if (params.metadata) payload.metadata = params.metadata

  const result = await paystackFetch<{
    authorization_url: string
    access_code: string
    reference: string
  }>('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  if (!result.ok) return result
  return {
    ok: true,
    data: {
      authorizationUrl: result.data.authorization_url,
      accessCode: result.data.access_code,
      reference: result.data.reference,
    },
  }
}

export async function verifyTransaction(
  reference: string,
): Promise<{ ok: true; data: PaystackVerifyResult } | { ok: false; error: string }> {
  const result = await paystackFetch<{
    status: string
    reference: string
    amount: number
    currency: string
    paid_at?: string | null
    gateway_response?: string
    metadata?: Record<string, unknown>
  }>(`/transaction/verify/${encodeURIComponent(reference)}`)

  if (!result.ok) return result
  return {
    ok: true,
    data: {
      status: result.data.status,
      reference: result.data.reference,
      amount: result.data.amount,
      currency: result.data.currency,
      paidAt: result.data.paid_at,
      gatewayResponse: result.data.gateway_response,
      metadata: result.data.metadata,
      raw: result.data,
    },
  }
}

export async function refundTransaction(params: {
  reference: string
  amountKobo?: number
  merchantNote?: string
}): Promise<{ ok: true; data: PaystackRefundResult } | { ok: false; error: string }> {
  const payload: Record<string, unknown> = {
    transaction: params.reference,
  }
  if (params.amountKobo != null) payload.amount = Math.round(params.amountKobo)
  if (params.merchantNote) payload.merchant_note = params.merchantNote

  const result = await paystackFetch<{
    id?: number | string
    status?: string
    amount?: number
    currency?: string
    transaction?: { reference?: string }
  }>('/refund', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  if (!result.ok) return result
  return {
    ok: true,
    data: {
      id: result.data.id,
      status: result.data.status ?? 'pending',
      amount: result.data.amount,
      currency: result.data.currency,
      transactionReference: result.data.transaction?.reference ?? params.reference,
      raw: result.data,
    },
  }
}

/**
 * Paystack signs webhooks with HMAC SHA512 of the raw body using the secret key.
 * Header: `x-paystack-signature`.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  const key = secretKey()
  if (!key || !signatureHeader) return false

  const expected = createHmac('sha512', key).update(rawBody, 'utf8').digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(signatureHeader, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}
