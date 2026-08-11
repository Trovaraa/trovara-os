import { Hono } from 'hono'
import { logSecurityEvent } from '../lib/security-log.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import { applySuccessfulPayment, reconcileRefund } from '../lib/order-payments.js'
import { isPaystackConfigured, verifyWebhookSignature } from '../lib/paystack.js'

export const paystackRoutes = new Hono()

type PaystackWebhookBody = {
  event?: string
  data?: {
    id?: number | string
    reference?: string
    amount?: number
    currency?: string
    status?: string
    metadata?: Record<string, unknown>
    transaction?: { reference?: string } | string
    transaction_reference?: string
  }
}

paystackRoutes.post('/webhook', async (c) => {
  if (!isPaystackConfigured()) {
    return c.json({ error: 'Paystack is not configured' }, 501)
  }

  const raw = await c.req.text()
  const signature = c.req.header('x-paystack-signature')
  if (!verifyWebhookSignature(raw, signature)) {
    logSecurityEvent('invalid_webhook_signature', {
      provider: 'paystack',
      reason: 'invalid_hmac',
      ip: clientIpFromHeaders((name) => c.req.header(name)),
    })
    return c.json({ error: 'Invalid signature' }, 401)
  }

  let body: PaystackWebhookBody
  try {
    body = JSON.parse(raw) as PaystackWebhookBody
  } catch {
    return c.json({ error: 'Invalid payload' }, 400)
  }

  if (body.event === 'charge.success') {
    const data = body.data
    const reference = data?.reference?.trim()
    const amountKobo = data?.amount
    const currency = data?.currency ?? 'NGN'

    if (!reference || amountKobo == null) {
      return c.json({ error: 'Missing reference or amount' }, 400)
    }

    const result = await applySuccessfulPayment({
      reference,
      amountKobo: Math.round(Number(amountKobo)),
      currency,
      providerEventId: data?.id != null ? String(data.id) : undefined,
      raw: data,
    })

    if (!result.ok) {
      console.error('Paystack charge.success apply failed:', result.error)
      // Return 200 for unknown refs to avoid endless retries on stale events;
      // return 422 for amount/currency mismatches so they surface in logs/ops.
      const status = result.error === 'Payment attempt not found' ? 200 : 422
      return c.json({ ok: false, error: result.error }, status)
    }

    return c.json({
      ok: true,
      alreadyApplied: result.alreadyApplied,
      orderId: result.orderId,
    })
  }

  if (body.event?.startsWith('refund.')) {
    const data = body.data
    const providerRefundId = data?.id != null ? String(data.id) : ''
    const transactionReference =
      typeof data?.transaction === 'object'
        ? data.transaction.reference?.trim()
        : data?.transaction?.trim() || data?.transaction_reference?.trim()
    if (!providerRefundId || !transactionReference || data?.amount == null) {
      return c.json({ error: 'Missing refund reconciliation fields' }, 400)
    }
    const result = await reconcileRefund({
      providerRefundId,
      transactionReference,
      amountKobo: Math.round(Number(data.amount)),
      providerStatus: data.status ?? body.event.slice('refund.'.length),
    })
    if (!result.ok) {
      console.error('Paystack refund reconciliation failed:', result.error)
      return c.json({ ok: false, error: result.error }, 200)
    }
    return c.json({ ok: true, refundId: result.refundId })
  }

  // Acknowledge other events without error so Paystack does not retry forever.
  return c.json({ ok: true, ignored: body.event ?? 'unknown' })
})
