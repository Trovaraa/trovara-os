import PDFDocument from 'pdfkit'
import { formatNaira } from './customer-cart.js'
import type { InvoiceSnapshot } from './invoice-html.js'

export async function renderInvoicePdf(params: {
  invoiceNumber: string
  amountKobo: number
  currency: string
  createdAt: Date | string
  snapshot: InvoiceSnapshot
  farmName?: string
  publicUrl?: string
}): Promise<Buffer> {
  const snap = params.snapshot ?? {}
  const currency = (snap.currency || params.currency || 'NGN').toUpperCase()
  const amountKobo = snap.amountKobo ?? params.amountKobo
  const lines = Array.isArray(snap.lines) ? snap.lines : []
  const created =
    typeof params.createdAt === 'string' ? new Date(params.createdAt) : params.createdAt
  const paidAt = snap.paidAt ? new Date(snap.paidAt) : null

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.font('Times-Bold').fontSize(18).text(`Invoice ${params.invoiceNumber}`)
    doc
      .font('Times-Roman')
      .fontSize(11)
      .fillColor('#555555')
      .text(params.farmName ?? 'Trovara Farm')
      .fillColor('#000000')
      .moveDown(1)

    const meta: string[] = []
    if (snap.orderReference) meta.push(`Order: ${snap.orderReference}`)
    if (snap.customerName) meta.push(`Customer: ${snap.customerName}`)
    if (snap.customerPhone) meta.push(`Phone: ${snap.customerPhone}`)
    if (snap.paymentReference) meta.push(`Payment ref: ${snap.paymentReference}`)
    meta.push(`Issued: ${created.toLocaleString()}`)
    if (paidAt && !Number.isNaN(paidAt.getTime())) {
      meta.push(`Paid: ${paidAt.toLocaleString()}`)
    }
    doc.fontSize(10).text(meta.join('\n'))
    doc.moveDown(1.2)

    const colItem = 48
    const colQty = 280
    const colUnit = 360
    const colLine = 450
    const rowY = () => doc.y

    doc.font('Times-Bold').fontSize(9).fillColor('#666666')
    const headerY = rowY()
    doc.text('ITEM', colItem, headerY, { width: 220 })
    doc.text('QTY', colQty, headerY, { width: 70, align: 'right' })
    doc.text('UNIT', colUnit, headerY, { width: 80, align: 'right' })
    doc.text('LINE', colLine, headerY, { width: 90, align: 'right' })
    doc
      .moveTo(48, doc.y + 4)
      .lineTo(547, doc.y + 4)
      .strokeColor('#dddddd')
      .stroke()
    doc.moveDown(0.6)
    doc.fillColor('#000000').font('Times-Roman').fontSize(10)

    if (!lines.length) {
      doc.text('No line items', colItem)
    } else {
      for (const line of lines) {
        const y = rowY()
        const qty = Number(line.quantity ?? 0)
        const unitPrice = Number(line.unitPriceKobo ?? 0)
        const lineTotal = Number(line.lineTotalKobo ?? 0)
        doc.text(String(line.productName ?? 'Item'), colItem, y, { width: 220 })
        doc.text(`${qty} ${line.unit ?? ''}`.trim(), colQty, y, { width: 70, align: 'right' })
        doc.text(formatNaira(unitPrice, currency), colUnit, y, { width: 80, align: 'right' })
        doc.text(formatNaira(lineTotal, currency), colLine, y, { width: 90, align: 'right' })
        doc.moveDown(0.35)
      }
    }

    doc.moveDown(1)
    doc
      .font('Times-Bold')
      .fontSize(12)
      .text(`Total ${formatNaira(amountKobo, currency)}`, { align: 'right' })

    doc.moveDown(2)
    doc
      .font('Times-Roman')
      .fontSize(9)
      .fillColor('#666666')
      .text('Trovara Farm · Abeokuta')
    if (params.publicUrl) {
      doc.text(params.publicUrl)
    }

    doc.end()
  })
}
