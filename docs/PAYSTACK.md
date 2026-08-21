# Paystack setup (Trovara OS)

Step-by-step guide to turn on customer payments for the **Telegram customer bot** and **WhatsApp customer number**. Staff butler channels never take payment.

See also: [`INTEGRATIONS.md`](./INTEGRATIONS.md) (overview), [`.env.example`](../.env.example).

---

## What you get

| Step | Behaviour |
|------|-----------|
| Customer confirms a **priced** cart | Bot creates a Paystack transaction and sends a **Pay now** link |
| Customer pays | Webhook marks payment paid → immutable invoice + receipt → auto-confirm if still `pending` → staff alert |
| Unpriced lines or no Paystack keys | Pay-on-delivery (`paymentStatus = not_required`) |
| Customer `cancel TRV-ORD-…` within 24h | Cancel allowed while `pending` / `confirmed`; unpaid abandons the attempt; paid sets `refund_pending` (staff refunds in Sales) |
| Dispatch / deliver | Blocked while `paymentStatus = unpaid` |

Amounts charged are the sum of `order_items.line_total_kobo` (not `orders.total_amount`).

---

## Prerequisites

1. Trovara OS API reachable on **public HTTPS** (`PUBLIC_APP_URL`).
2. Migration `0026_paystack_payments` applied (`npm run db:migrate -w api`).
3. Customer ordering already working (Telegram customer bot and/or WhatsApp customer phone number id).
4. Catalogue products with prices &gt; 0 (kobo).

---

## 1. Create a Paystack account

1. Sign up at [https://dashboard.paystack.com/](https://dashboard.paystack.com/).
2. Complete business verification when you are ready for **live** keys (test keys work immediately).
3. Open **Settings → API Keys & Webhooks**.

---

## 2. Add keys to `.env`

```bash
# Test first; switch to sk_live_ / pk_live_ for production
PAYSTACK_SECRET_KEY=sk_test_xxxxxxxx
PAYSTACK_PUBLIC_KEY=pk_test_xxxxxxxx

# Must match the URL customers and Paystack can reach
PUBLIC_APP_URL=https://os.trovara.farm
```

Restart the API after changing env vars.

Leave both keys blank to keep **COD-only** behaviour.

---

## 3. Register the webhook

In Paystack Dashboard → **Settings → API Keys & Webhooks**:

| Field | Value |
|-------|--------|
| Webhook URL | `https://YOUR_DOMAIN/api/paystack/webhook` |
| Events | At least **charge.success** |

Signature: Paystack sends `x-paystack-signature` = HMAC-SHA512 of the **raw body** with `PAYSTACK_SECRET_KEY`. Trovara verifies this; the path is CSRF-exempt.

**Local development:** expose the API with a tunnel, e.g.

```bash
ngrok http 3000
# Webhook: https://<id>.ngrok-free.app/api/paystack/webhook
# Also set PUBLIC_APP_URL to that same https origin for pay links / callback
```

---

## 4. Checkout callback page

After paying, Paystack redirects the browser to:

`{PUBLIC_APP_URL}/pay/callback?reference=…`

This is a short thank-you page in the Vue app. **Order confirmation is webhook-driven**, not callback-driven. If the customer closes the browser early, payment still applies when the webhook arrives.

---

## 5. Migrate and smoke-test

```bash
cd trovara-os
source ~/.nvm/nvm.sh && nvm use 22
npm run db:migrate -w api
# restart API
```

### Happy path

1. Message the **customer** Telegram bot (or WhatsApp customer number).
2. Place an order with priced products → confirm with `YES`.
3. Open the **Pay now** link; pay with a [Paystack test card](https://paystack.com/docs/payments/test-payments/).
4. In **Sales**: order should show **Paid**, fulfilment **confirmed**, invoice available (HTML + PDF).
5. Confirm staff order alerts mention payment / confirmation.

### Cancel / refund

1. Within 24 hours, send `cancel TRV-ORD-…` from the same customer chat.
2. If unpaid → cancelled only. If paid → cancelled + **refund pending**.
3. In Sales, use **Refund** (copy notes refunds usually land in about **1 week**).

### Ops checks

- **Resend pay link** / **Verify payment** on unpaid orders if the webhook was missed.
- **Finance**: Paid (Paystack), outstanding unpaid, refunds, and pending refunds are separate from fulfilment revenue.

---

## 6. Go live checklist

- [ ] Switch to `sk_live_` / `pk_live_` keys
- [ ] Webhook URL points at production HTTPS
- [ ] `PUBLIC_APP_URL` is the production app origin
- [ ] Place one real small order and refund it as a dress rehearsal
- [ ] Confirm Meta WhatsApp customer number is provisioned if you sell on WA (`WHATSAPP_CUSTOMER_PHONE_NUMBER_ID`)

---

## Staff surfaces

| Surface | Actions |
|---------|---------|
| Sales | Payment badges, resend link, verify, refund, open HTML invoice, download PDF |
| Finance | Paid revenue, outstanding unpaid, refunds paid / pending (independent of P&amp;L fulfilment revenue) |
| Public | `/public/invoices/:token` (HTML), `/public/invoices/:token/pdf` |

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| No pay link; COD copy | `PAYSTACK_SECRET_KEY` set? All line prices &gt; 0? |
| Paid in Paystack but order unpaid | Webhook URL / signature; use **Verify payment** in Sales |
| 401 on webhook | Secret key mismatch; ensure raw body HMAC (not JSON re-serialized) |
| Cannot dispatch | Order still `unpaid` — wait for webhook or verify |
| Cancel refused | Outside 24h window, or already dispatched / cancelled |

---

## Related env (channels)

```bash
# Telegram customer bot (existing)
TELEGRAM_CUSTOMER_BOT_TOKEN=

# WhatsApp customer number (can be the only Meta number in a customer-only setup)
WHATSAPP_CUSTOMER_PHONE_NUMBER_ID=
# WHATSAPP_CUSTOMER_ACCESS_TOKEN=   # preferred when staff WhatsApp is disabled
```
