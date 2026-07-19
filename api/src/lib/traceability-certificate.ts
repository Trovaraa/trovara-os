/**
 * Shared wording + HTML for Trovara Farm Traceability Certificates.
 *
 * Privacy: public surfaces never include phone. Customer display is redacted
 * (first name + last initial). Staff/owner certificates may show the full name.
 */

export const CERTIFICATE_TITLE = 'Trovara Farm Traceability Certificate'

export const BOX_LABEL_SCAN_HINT = 'Scan to verify origin'

export const CERTIFICATE_WHY = [
  'This certificate lets buyers and partners verify where this produce came from.',
  'It confirms the harvest lot was recorded by the farm and checked before leaving the farm —',
  'farm name, product, quantity, and harvest date. It is a provenance record, not a legal title of ownership.',
].join(' ')

export function escapeHtml(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Public-safe label: "Ada Okafor" → "Ada O."; single token left as-is. */
export function redactCustomerDisplayName(fullName: string | null | undefined): string | null {
  if (!fullName) return null
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  if (parts.length === 1) return parts[0]!
  const first = parts[0]!
  const lastInitial = parts[parts.length - 1]!.charAt(0).toUpperCase()
  return `${first} ${lastInitial}.`
}

export type CertificateLotFields = {
  lotCode: string
  productName: string
  quantityKg: number
  unit?: string | null
  harvestedAt: Date | string
  plotName?: string | null
  cropType?: string | null
  publicNotes?: string | null
  farmName: string
  farmLocation?: string | null
  /** Full name — used only when audience is staff */
  customerName?: string | null
  /** Already-redacted name for public certificates */
  preparedForPublic?: string | null
  orderReference?: string | null
}

export type RenderCertificateOptions = {
  publicUrl: string
  qrSvg: string
  audience: 'public' | 'staff'
  timelineHtml?: string
  generatedAt?: Date
}

function preparedForLine(lot: CertificateLotFields, audience: 'public' | 'staff'): string | null {
  if (audience === 'staff') {
    const name = lot.customerName?.trim()
    if (!name) return null
    return name
  }
  return lot.preparedForPublic?.trim() || redactCustomerDisplayName(lot.customerName)
}

export function renderTraceabilityCertificateHtml(
  lot: CertificateLotFields,
  opts: RenderCertificateOptions,
): string {
  const unit = lot.unit === 'crates' ? 'crates' : 'kg'
  const preparedFor = preparedForLine(lot, opts.audience)
  const generated = (opts.generatedAt ?? new Date()).toLocaleString()
  const harvested = new Date(lot.harvestedAt).toLocaleDateString()

  const preparedRow = preparedFor
    ? `<div class="row"><b>Prepared for</b> ${escapeHtml(preparedFor)}</div>`
    : ''
  const orderRow = lot.orderReference
    ? `<div class="row"><b>Order</b> ${escapeHtml(lot.orderReference)}</div>`
    : ''

  const timelineSection =
    opts.audience === 'staff' && opts.timelineHtml != null
      ? `
  <h2>Timeline events</h2>
  <table>
    <thead>
      <tr><th>Time</th><th>Event</th></tr>
    </thead>
    <tbody>
      ${opts.timelineHtml || '<tr><td colspan="2">No events found.</td></tr>'}
    </tbody>
  </table>`
      : ''

  const actions =
    opts.audience === 'public'
      ? `
  <div class="actions">
    <button type="button" onclick="window.print()">Download / print certificate</button>
  </div>`
      : ''

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(CERTIFICATE_TITLE)} - ${escapeHtml(lot.lotCode)}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111827; margin: 24px; max-width: 720px; }
    h1 { margin: 0 0 4px; font-size: 22px; }
    h2 { margin: 24px 0 8px; font-size: 16px; }
    .subtle { color: #6b7280; font-size: 13px; }
    .why { margin-top: 14px; line-height: 1.45; font-size: 14px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 20px; margin-top: 16px; }
    .row b { display: inline-block; min-width: 140px; }
    .qr { margin-top: 20px; display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
    th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; }
    .actions { margin-top: 24px; }
    .actions button {
      display: inline-block; background: #166534; color: #fff; border: 0;
      padding: 10px 16px; border-radius: 8px; font-size: 14px; cursor: pointer;
    }
    @media print {
      body { margin: 10mm; }
      a { color: inherit; text-decoration: none; }
      .actions { display: none; }
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(CERTIFICATE_TITLE)}</h1>
  <div class="subtle">Verified harvest · Generated ${escapeHtml(generated)}</div>
  <p class="why">${escapeHtml(CERTIFICATE_WHY)}</p>

  <div class="grid">
    <div class="row"><b>Farm</b> ${escapeHtml(lot.farmName)}</div>
    <div class="row"><b>Location</b> ${escapeHtml(lot.farmLocation ?? '-')}</div>
    <div class="row"><b>Lot code</b> ${escapeHtml(lot.lotCode)}</div>
    <div class="row"><b>Product</b> ${escapeHtml(lot.productName)}</div>
    <div class="row"><b>Quantity</b> ${lot.quantityKg} ${unit}</div>
    <div class="row"><b>Harvested</b> ${escapeHtml(harvested)}</div>
    <div class="row"><b>Plot</b> ${escapeHtml(lot.plotName ?? '-')}</div>
    <div class="row"><b>Crop type</b> ${escapeHtml(lot.cropType ?? '-')}</div>
    ${preparedRow}
    ${orderRow}
  </div>

  <h2>Online verification</h2>
  <div class="qr">
    <div>${opts.qrSvg}</div>
    <div>
      <div><a href="${escapeHtml(opts.publicUrl)}">${escapeHtml(opts.publicUrl)}</a></div>
      <div class="subtle" style="margin-top:8px;">Scan to open this certificate online (public verification page).</div>
      <div style="margin-top:12px;"><b>Public notes:</b> ${escapeHtml(lot.publicNotes ?? '-')}</div>
    </div>
  </div>
  ${timelineSection}
  ${actions}
</body>
</html>`
}

export type BoxLabelFields = {
  lotCode: string
  productName: string
  quantityKg: number
  unit?: string | null
  farmName: string
  /** Redacted or omitted — outer box label stays light on PII */
  preparedForPublic?: string | null
  orderReference?: string | null
}

/** Compact print sticker for a delivery box (QR + lot code + scan hint). */
export function renderBoxLabelHtml(
  lot: BoxLabelFields,
  opts: { publicUrl: string; qrSvg: string; autoPrint?: boolean },
): string {
  const unit = lot.unit === 'crates' ? 'crates' : 'kg'
  const prepared = lot.preparedForPublic?.trim()
  const order = lot.orderReference?.trim()
  const autoPrint = opts.autoPrint
    ? `<script>window.addEventListener('load',function(){setTimeout(function(){window.print()},250)})</script>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Box label - ${escapeHtml(lot.lotCode)}</title>
  <style>
    @page { size: 100mm 70mm; margin: 4mm; }
    body {
      font-family: Arial, sans-serif; color: #111827; margin: 0;
      display: flex; justify-content: center; padding: 12px;
    }
    .label {
      width: 92mm; min-height: 58mm; border: 2px solid #166534; border-radius: 6px;
      padding: 8px 10px; display: flex; gap: 10px; align-items: center; box-sizing: border-box;
    }
    .qr { width: 38mm; height: 38mm; flex-shrink: 0; }
    .qr svg { width: 100%; height: 100%; display: block; }
    .meta { flex: 1; min-width: 0; }
    .brand { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #166534; }
    .hint { font-size: 12px; font-weight: 700; margin-top: 2px; }
    .code { font-family: ui-monospace, monospace; font-size: 15px; font-weight: 800; margin-top: 6px; word-break: break-all; }
    .line { font-size: 11px; color: #374151; margin-top: 3px; }
    .actions { position: fixed; bottom: 16px; left: 0; right: 0; text-align: center; }
    .actions button {
      background: #166534; color: #fff; border: 0; padding: 10px 16px;
      border-radius: 8px; font-size: 14px; cursor: pointer;
    }
    @media print {
      body { padding: 0; }
      .actions { display: none; }
      .label { border-radius: 0; }
    }
  </style>
</head>
<body>
  <div class="label">
    <div class="qr">${opts.qrSvg}</div>
    <div class="meta">
      <div class="brand">Trovara</div>
      <div class="hint">${escapeHtml(BOX_LABEL_SCAN_HINT)}</div>
      <div class="code">${escapeHtml(lot.lotCode)}</div>
      <div class="line">${escapeHtml(lot.productName)} · ${lot.quantityKg} ${unit}</div>
      <div class="line">${escapeHtml(lot.farmName)}</div>
      ${order ? `<div class="line">${escapeHtml(order)}</div>` : ''}
      ${prepared ? `<div class="line">For ${escapeHtml(prepared)}</div>` : ''}
    </div>
  </div>
  <div class="actions">
    <button type="button" onclick="window.print()">Print label</button>
  </div>
  ${autoPrint}
</body>
</html>`
}
