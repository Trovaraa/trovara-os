import { Hono } from 'hono'
import QRCode from 'qrcode'
import { and, eq, or } from 'drizzle-orm'
import { db } from '../db/index.js'
import { assets, inventoryItems } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requirePermission } from '../lib/rbac.js'

function cleanCode(value: string): string {
  return value.trim().slice(0, 200)
}

export const scanningRoutes = new Hono<{ Variables: AppVariables }>()
scanningRoutes.use('*', authMiddleware)

scanningRoutes.get('/resolve', async (c) => {
  const user = c.get('user')
  requirePermission(user, 'scan.use')
  const code = cleanCode(c.req.query('code') ?? '')
  if (!code) return c.json({ error: 'Scan code is required' }, 400)

  const token = code.match(/^TRV:(INV|AST):([0-9a-f-]{36})$/i)
  const id = token?.[2]
  if (token?.[1].toUpperCase() === 'INV') {
    const [item] = await db.select().from(inventoryItems)
      .where(and(eq(inventoryItems.farmId, user.farmId), eq(inventoryItems.id, id!))).limit(1)
    return item ? c.json({ kind: 'inventory', record: item }) : c.json({ error: 'Code not found' }, 404)
  }
  if (token?.[1].toUpperCase() === 'AST') {
    const [asset] = await db.select().from(assets)
      .where(and(eq(assets.farmId, user.farmId), eq(assets.id, id!))).limit(1)
    return asset ? c.json({ kind: 'asset', record: asset }) : c.json({ error: 'Code not found' }, 404)
  }

  const [item] = await db.select().from(inventoryItems).where(and(
    eq(inventoryItems.farmId, user.farmId),
    or(eq(inventoryItems.sku, code), eq(inventoryItems.scanCode, code)),
  )).limit(1)
  if (item) return c.json({ kind: 'inventory', record: item })

  const [asset] = await db.select().from(assets).where(and(
    eq(assets.farmId, user.farmId),
    or(eq(assets.assetTag, code), eq(assets.scanCode, code)),
  )).limit(1)
  return asset ? c.json({ kind: 'asset', record: asset }) : c.json({ error: 'Code not found' }, 404)
})

scanningRoutes.get('/label/:kind/:id', async (c) => {
  const user = c.get('user')
  requirePermission(user, 'scan.use')
  const kind = c.req.param('kind')
  const id = c.req.param('id')
  let name = ''
  let detail = ''
  let payload = ''

  if (kind === 'inventory') {
    const [row] = await db.select().from(inventoryItems)
      .where(and(eq(inventoryItems.id, id), eq(inventoryItems.farmId, user.farmId))).limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)
    name = row.name
    detail = `${row.sku} · ${row.unit}`
    payload = `TRV:INV:${row.id}`
  } else if (kind === 'asset') {
    const [row] = await db.select().from(assets)
      .where(and(eq(assets.id, id), eq(assets.farmId, user.farmId))).limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)
    name = row.name
    detail = row.assetTag || row.serialNumber || 'Equipment'
    payload = `TRV:AST:${row.id}`
  } else {
    return c.json({ error: 'Invalid label type' }, 400)
  }

  const qr = await QRCode.toDataURL(payload, { width: 360, margin: 1 })
  return c.json({ name, detail, payload, qr })
})
