import { and, desc, eq } from 'drizzle-orm'
import QRCode from 'qrcode'
import { db } from '../db/index.js'
import { farms, harvestLots, orders } from '../db/schema.js'
import { orderReference } from './customer-cart.js'
import { publicAppBaseUrl, publicLotPageUrl } from './public-app-url.js'
import {
  redactCustomerDisplayName,
  renderBoxLabelHtml,
} from './traceability-certificate.js'

export { publicLotPageUrl }

export function publicLotLabelUrl(farmSlug: string | null | undefined, publicToken: string): string {
  return `${publicAppBaseUrl()}/public/lots/${farmSlug ?? 'farm'}/${publicToken}/label.html`
}

export type PrintableLot = {
  id: string
  lotCode: string
  publicToken: string
  productName: string
  quantityKg: number
  unit: string | null
  farmSlug: string | null
  farmName: string
  orderId: string | null
  customerName: string | null
}

export async function findPrintableLotById(farmId: string, lotId: string): Promise<PrintableLot | null> {
  const [lot] = await db
    .select({
      id: harvestLots.id,
      lotCode: harvestLots.lotCode,
      publicToken: harvestLots.publicToken,
      productName: harvestLots.productName,
      quantityKg: harvestLots.quantityKg,
      unit: harvestLots.unit,
      farmSlug: farms.slug,
      farmName: farms.name,
      orderId: harvestLots.orderId,
      customerName: orders.customerName,
    })
    .from(harvestLots)
    .innerJoin(farms, eq(harvestLots.farmId, farms.id))
    .leftJoin(orders, eq(harvestLots.orderId, orders.id))
    .where(and(eq(harvestLots.id, lotId), eq(harvestLots.farmId, farmId)))
    .limit(1)
  return lot ?? null
}

/** Match exact lot code, or trailing fragment (e.g. ORD-…-001). */
export async function findPrintableLotByCode(
  farmId: string,
  rawCode: string,
): Promise<PrintableLot | null> {
  const code = rawCode.trim().toUpperCase()
  if (!code) return null

  const exact = await db
    .select({
      id: harvestLots.id,
      lotCode: harvestLots.lotCode,
      publicToken: harvestLots.publicToken,
      productName: harvestLots.productName,
      quantityKg: harvestLots.quantityKg,
      unit: harvestLots.unit,
      farmSlug: farms.slug,
      farmName: farms.name,
      orderId: harvestLots.orderId,
      customerName: orders.customerName,
    })
    .from(harvestLots)
    .innerJoin(farms, eq(harvestLots.farmId, farms.id))
    .leftJoin(orders, eq(harvestLots.orderId, orders.id))
    .where(and(eq(harvestLots.farmId, farmId), eq(harvestLots.lotCode, code)))
    .limit(1)

  if (exact[0]) return exact[0]

  const rows = await db
    .select({
      id: harvestLots.id,
      lotCode: harvestLots.lotCode,
      publicToken: harvestLots.publicToken,
      productName: harvestLots.productName,
      quantityKg: harvestLots.quantityKg,
      unit: harvestLots.unit,
      farmSlug: farms.slug,
      farmName: farms.name,
      orderId: harvestLots.orderId,
      customerName: orders.customerName,
    })
    .from(harvestLots)
    .innerJoin(farms, eq(harvestLots.farmId, farms.id))
    .leftJoin(orders, eq(harvestLots.orderId, orders.id))
    .where(eq(harvestLots.farmId, farmId))
    .orderBy(desc(harvestLots.createdAt))
    .limit(80)

  return rows.find((r) => r.lotCode.toUpperCase().endsWith(code) || r.lotCode.toUpperCase() === code) ?? null
}

export async function listRecentPrintableLots(farmId: string, limit = 8): Promise<PrintableLot[]> {
  return db
    .select({
      id: harvestLots.id,
      lotCode: harvestLots.lotCode,
      publicToken: harvestLots.publicToken,
      productName: harvestLots.productName,
      quantityKg: harvestLots.quantityKg,
      unit: harvestLots.unit,
      farmSlug: farms.slug,
      farmName: farms.name,
      orderId: harvestLots.orderId,
      customerName: orders.customerName,
    })
    .from(harvestLots)
    .innerJoin(farms, eq(harvestLots.farmId, farms.id))
    .leftJoin(orders, eq(harvestLots.orderId, orders.id))
    .where(eq(harvestLots.farmId, farmId))
    .orderBy(desc(harvestLots.createdAt))
    .limit(limit)
}

export async function buildBoxLabelHtml(
  lot: PrintableLot,
  opts?: { autoPrint?: boolean },
): Promise<{ html: string; publicUrl: string; labelUrl: string }> {
  const publicUrl = publicLotPageUrl(lot.farmSlug, lot.publicToken)
  const labelUrl = publicLotLabelUrl(lot.farmSlug, lot.publicToken)
  const qrSvg = await QRCode.toString(publicUrl, { type: 'svg', margin: 1, width: 280 })
  const html = renderBoxLabelHtml(
    {
      lotCode: lot.lotCode,
      productName: lot.productName,
      quantityKg: lot.quantityKg,
      unit: lot.unit,
      farmName: lot.farmName,
      preparedForPublic: redactCustomerDisplayName(lot.customerName),
      orderReference: lot.orderId ? orderReference(lot.orderId) : null,
    },
    { publicUrl, qrSvg, autoPrint: opts?.autoPrint },
  )
  return { html, publicUrl, labelUrl }
}

export async function buildLotQrPng(lot: PrintableLot): Promise<{ png: Buffer; publicUrl: string; labelUrl: string }> {
  const publicUrl = publicLotPageUrl(lot.farmSlug, lot.publicToken)
  const labelUrl = publicLotLabelUrl(lot.farmSlug, lot.publicToken)
  const png = await QRCode.toBuffer(publicUrl, { type: 'png', margin: 1, width: 512 })
  return { png, publicUrl, labelUrl }
}

export function printQrPickerKeyboard(lots: PrintableLot[]) {
  return {
    inline_keyboard: lots.slice(0, 8).map((lot) => [
      {
        text: `${lot.lotCode} · ${lot.productName}`.slice(0, 64),
        callback_data: `label:${lot.id}`,
      },
    ]),
  }
}
