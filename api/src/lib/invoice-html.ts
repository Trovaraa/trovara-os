import { escapeHtml } from './traceability-certificate.js'
import { formatNaira } from './customer-cart.js'

export type InvoiceSnapshotLine = {
  productName?: string
  unit?: string
  quantity?: number
  unitPriceKobo?: number
  lineTotalKobo?: number
}

export type InvoiceSnapshot = {
  orderReference?: string
  customerName?: string
  customerPhone?: string | null
  source?: string
  paymentReference?: string
  lines?: InvoiceSnapshotLine[]
  amountKobo?: number
  currency?: string
  paidAt?: string
}

export function renderInvoiceHtml(params: {
  invoiceNumber: string
  amountKobo: number
  currency: string
  createdAt: Date | string
  snapshot: InvoiceSnapshot
  farmName?: string
  publicUrl?: string
  autoPrint?: boolean
}): string {
  const snap = params.snapshot ?? {}
  const currency = (snap.currency || params.currency || 'NGN').toUpperCase()
  const amountKobo = snap.amountKobo ?? params.amountKobo
  const lines = Array.isArray(snap.lines) ? snap.lines : []
  const created =
    typeof params.createdAt === 'string'
      ? new Date(params.createdAt)
      : params.createdAt
  const paidAt = snap.paidAt ? new Date(snap.paidAt) : null

  const lineRows = lines
    .map((line) => {
      const qty = Number(line.quantity ?? 0)
      const unitPrice = Number(line.unitPriceKobo ?? 0)
      const lineTotal = Number(line.lineTotalKobo ?? 0)
      return `<tr>
        <td>${escapeHtml(line.productName ?? 'Item')}</td>
        <td class="num">${escapeHtml(String(qty))} ${escapeHtml(line.unit ?? '')}</td>
        <td class="num">${escapeHtml(formatNaira(unitPrice, currency))}</td>
        <td class="num">${escapeHtml(formatNaira(lineTotal, currency))}</td>
      </tr>`
    })
    .join('')

  const autoPrintScript = params.autoPrint
    ? `<script>window.addEventListener('load',()=>window.print())</script>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(params.invoiceNumber)} — Trovara Farm</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: Georgia, 'Times New Roman', serif; margin: 0; padding: 32px; color: #1a1a1a; background: #fff; }
    h1 { font-size: 1.5rem; margin: 0 0 4px; letter-spacing: 0.02em; }
    .muted { color: #555; font-size: 0.9rem; }
    .meta { margin: 24px 0; display: grid; gap: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #ddd; font-size: 0.95rem; }
    th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: #666; }
    .num { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, monospace; }
    .total { margin-top: 20px; font-size: 1.15rem; font-weight: bold; text-align: right; }
    .footer { margin-top: 40px; font-size: 0.8rem; color: #666; border-top: 1px solid #eee; padding-top: 12px; }
    @media print { body { padding: 12px; } }
  </style>
</head>
<body>
  <h1>Invoice ${escapeHtml(params.invoiceNumber)}</h1>
  <p class="muted">${escapeHtml(params.farmName ?? 'Trovara Farm')}</p>
  <div class="meta">
    ${snap.orderReference ? `<div><strong>Order</strong> ${escapeHtml(snap.orderReference)}</div>` : ''}
    ${snap.customerName ? `<div><strong>Customer</strong> ${escapeHtml(snap.customerName)}</div>` : ''}
    ${snap.customerPhone ? `<div><strong>Phone</strong> ${escapeHtml(snap.customerPhone)}</div>` : ''}
    ${snap.paymentReference ? `<div><strong>Payment ref</strong> ${escapeHtml(snap.paymentReference)}</div>` : ''}
    <div><strong>Issued</strong> ${escapeHtml(created.toLocaleString())}</div>
    ${paidAt && !Number.isNaN(paidAt.getTime()) ? `<div><strong>Paid</strong> ${escapeHtml(paidAt.toLocaleString())}</div>` : ''}
  </div>
  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th class="num">Qty</th>
        <th class="num">Unit</th>
        <th class="num">Line</th>
      </tr>
    </thead>
    <tbody>
      ${lineRows || '<tr><td colspan="4">No line items</td></tr>'}
    </tbody>
  </table>
  <p class="total">Total ${escapeHtml(formatNaira(amountKobo, currency))}</p>
  <div class="footer">
    Trovara Farm · Abeokuta
    ${params.publicUrl ? ` · <a href="${escapeHtml(params.publicUrl)}">${escapeHtml(params.publicUrl)}</a>` : ''}
  </div>
  ${autoPrintScript}
</body>
</html>`
}
