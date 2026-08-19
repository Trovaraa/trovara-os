import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { getCookie, setCookie } from 'hono/cookie'
import { Readable } from 'node:stream'
import { db } from '../db/index.js'
import { brandAssets, brandPackAssets, brandPacks } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { hasPermission } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import {
  brandFarmRoot,
  assertBrandStorageCapacity,
  brandMediaAbsolutePath,
  createBrandUploadSession,
  deleteBrandMedia,
  newShareToken,
  openBrandMediaRange,
  openBrandMediaStream,
  removeBrandUploadSession,
  storeBrandMedia,
  streamRequestBodyToFile,
} from '../lib/brand-media.js'
import {
  brandPackSessionCookieName,
  brandPackSessionCookieOptions,
  createBrandPackSessionToken,
  verifyBrandPackSessionToken,
} from '../lib/brand-pack-session.js'
import { publicBrandPackUrl } from '../lib/public-app-url.js'
import { hashPassword, verifyPassword } from '../lib/session.js'
import { checkDurableRateLimit } from '../lib/rate-limit.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import { hashedRateKey } from '../middleware/security.js'
import { createStoredZipStream } from '../lib/streaming-zip.js'
import {
  BRAND_MAX_UPLOAD_BYTES,
  mediaKindForMime,
  normalizeBrandMime,
} from '../lib/brand-limits.js'
import { enqueueBrandAssetProcessing } from '../lib/brand-processing.js'
import { resolve } from 'node:path'

const PUBLIC_RATE = { max: 120, windowMs: 60_000 }
const UNLOCK_MAX = 8
const UNLOCK_WINDOW_MS = 15 * 60_000
const activeUploadsByFarm = new Set<string>()

const mediaSchema = z.object({
  dataUrl: z.string().max(14_000_000),
  originalName: z.string().trim().min(1).max(240).optional(),
})

const packSchema = z.object({
  title: z.string().trim().min(1).max(160),
  notes: z.string().trim().max(2000).optional().nullable(),
  assetIds: z
    .array(z.string().uuid())
    .min(1)
    .max(80)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate assets are not allowed'),
  password: z.string().min(4).max(128).optional().nullable(),
  clearPassword: z.boolean().optional(),
  expiresAt: z.string().datetime().optional().nullable(),
})

const unlockSchema = z.object({
  password: z.string().min(1).max(128).optional(),
})

export const brandRoutes = new Hono<{ Variables: AppVariables }>()
export const publicBrandRoutes = new Hono()

brandRoutes.use('*', authMiddleware)

function packIsActive(pack: typeof brandPacks.$inferSelect, now = new Date()): boolean {
  if (pack.revokedAt) return false
  if (pack.expiresAt && pack.expiresAt.getTime() <= now.getTime()) return false
  return true
}

function serializeAsset(row: typeof brandAssets.$inferSelect) {
  const ready = row.status === 'ready' && row.filename
  return {
    id: row.id,
    filename: row.filename,
    originalName: row.originalName,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    mediaKind: row.mediaKind,
    status: row.status,
    processingError: row.processingError,
    sourceMimeType: row.sourceMimeType,
    durationSeconds: row.durationSeconds,
    previewUrl: ready ? `/api/brand/assets/${row.id}/media` : null,
    posterUrl:
      ready && row.posterFilename ? `/api/brand/assets/${row.id}/poster` : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializePack(
  pack: typeof brandPacks.$inferSelect,
  assetIds: string[],
) {
  return {
    id: pack.id,
    title: pack.title,
    notes: pack.notes,
    shareToken: pack.shareToken,
    shareUrl: publicBrandPackUrl(pack.shareToken),
    passwordRequired: Boolean(pack.passwordHash),
    expiresAt: pack.expiresAt?.toISOString() ?? null,
    revokedAt: pack.revokedAt?.toISOString() ?? null,
    viewCount: pack.viewCount,
    downloadCount: pack.downloadCount,
    assetIds,
    createdAt: pack.createdAt.toISOString(),
    updatedAt: pack.updatedAt.toISOString(),
  }
}

async function packAssetIds(packId: string, farmId?: string): Promise<string[]> {
  const rows = await db
    .select({ assetId: brandPackAssets.assetId })
    .from(brandPackAssets)
    .where(
      farmId
        ? and(eq(brandPackAssets.packId, packId), eq(brandPackAssets.farmId, farmId))
        : eq(brandPackAssets.packId, packId),
    )
    .orderBy(asc(brandPackAssets.position))
  return rows.map((r) => r.assetId)
}

type DbExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function replacePackAssets(
  executor: DbExecutor,
  farmId: string,
  packId: string,
  assetIds: string[],
): Promise<void> {
  await executor
    .delete(brandPackAssets)
    .where(and(eq(brandPackAssets.packId, packId), eq(brandPackAssets.farmId, farmId)))
  if (assetIds.length === 0) return
  await executor.insert(brandPackAssets).values(
    assetIds.map((assetId, position) => ({ farmId, packId, assetId, position })),
  )
}

async function assertReadyAssets(farmId: string, assetIds: string[]): Promise<Response | null> {
  const owned = await db
    .select({
      id: brandAssets.id,
      status: brandAssets.status,
      originalName: brandAssets.originalName,
    })
    .from(brandAssets)
    .where(and(eq(brandAssets.farmId, farmId), inArray(brandAssets.id, assetIds)))
  if (owned.length !== assetIds.length) {
    return new Response(JSON.stringify({ error: 'One or more assets were not found' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const notReady = owned.filter((row) => row.status !== 'ready')
  if (notReady.length) {
    return new Response(
      JSON.stringify({
        error: `Asset still processing: ${notReady.map((r) => r.originalName).join(', ')}`,
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }
  return null
}

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  const match = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (!match[1] && !match[2])) return 'invalid'
  const suffixLength = !match[1] && match[2] ? Number(match[2]) : null
  const start =
    suffixLength == null ? Number(match[1]) : Math.max(0, size - suffixLength)
  const end = match[1] && match[2] ? Number(match[2]) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return 'invalid'
  }
  return { start, end: Math.min(end, size - 1) }
}

async function mediaResponse(
  farmId: string,
  filename: string,
  rangeHeader: string | undefined,
  cacheControl: string,
) {
  const full = await openBrandMediaStream(farmId, filename)
  const range = parseRange(rangeHeader, full.size)
  if (range === 'invalid') {
    full.stream.destroy()
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${full.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
      },
    })
  }
  if (range) {
    full.stream.destroy()
    const partial = await openBrandMediaRange(farmId, filename, range.start, range.end)
    const length = range.end - range.start + 1
    return new Response(Readable.toWeb(partial.stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': partial.contentType,
        'Content-Length': String(length),
        'Content-Range': `bytes ${range.start}-${range.end}/${partial.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }
  return new Response(Readable.toWeb(full.stream) as ReadableStream, {
    headers: {
      'Content-Type': full.contentType,
      'Content-Length': String(full.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

brandRoutes.get('/assets', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'brand.manage')) return c.json({ error: 'Forbidden' }, 403)
  const rows = await db
    .select()
    .from(brandAssets)
    .where(eq(brandAssets.farmId, user.farmId))
    .orderBy(desc(brandAssets.createdAt))
  return c.json({ assets: rows.map(serializeAsset) })
})

brandRoutes.get('/assets/:id', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'brand.manage')) return c.json({ error: 'Forbidden' }, 403)
  const [row] = await db
    .select()
    .from(brandAssets)
    .where(and(eq(brandAssets.id, c.req.param('id')), eq(brandAssets.farmId, user.farmId)))
    .limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  return c.json({ asset: serializeAsset(row) })
})

brandRoutes.post('/assets', zValidator('json', mediaSchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'brand.manage')) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  let stored
  try {
    stored = await storeBrandMedia(user.farmId, body.dataUrl)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Upload failed' }, 400)
  }
  const originalName = body.originalName?.trim() || stored.filename
  let row: typeof brandAssets.$inferSelect
  try {
    const [inserted] = await db
      .insert(brandAssets)
      .values({
        farmId: user.farmId,
        filename: stored.filename,
        originalName,
        mimeType: stored.mimeType,
        byteSize: stored.byteSize,
        mediaKind: 'image',
        status: 'ready',
        sourceMimeType: stored.mimeType,
        createdById: user.id,
      })
      .returning()
    row = inserted!
  } catch (error) {
    await deleteBrandMedia(user.farmId, stored.filename).catch(() => undefined)
    throw error
  }
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'brand_asset',
    entityId: row.id,
    metadata: { originalName, mimeType: stored.mimeType },
  })
  return c.json({ asset: serializeAsset(row) }, 201)
})

async function beginStreamedUpload(params: {
  farmId: string
  userId: string
  assetId?: string
  contentType: string | undefined
  contentLength: string | undefined
  originalNameHeader: string | undefined
  body: ReadableStream<Uint8Array> | null
  replace?: boolean
}) {
  if (activeUploadsByFarm.has(params.farmId)) {
    return { error: 'Another Brand Kit upload is already in progress for this farm', status: 429 as const }
  }
  const originalName =
    params.originalNameHeader?.trim() ||
    (params.replace ? undefined : 'upload')
  const mime = normalizeBrandMime(params.contentType, originalName)
  if (!mime || !mediaKindForMime(mime)) {
    return { error: 'Unsupported media type', status: 415 as const }
  }
  const kind = mediaKindForMime(mime)!

  let existing: typeof brandAssets.$inferSelect | undefined
  if (params.replace && params.assetId) {
    const [row] = await db
      .select()
      .from(brandAssets)
      .where(and(eq(brandAssets.id, params.assetId), eq(brandAssets.farmId, params.farmId)))
      .limit(1)
    if (!row) return { error: 'Not found', status: 404 as const }
    if (row.status === 'processing' || row.status === 'uploading' || row.pendingSourcePath) {
      return { error: 'Asset is still processing', status: 409 as const }
    }
    if (row.mediaKind !== kind && row.status === 'ready') {
      return { error: `Replace must keep media kind (${row.mediaKind})`, status: 409 as const }
    }
    existing = row
  }

  const declaredLength = Number(params.contentLength)
  // Reserve the declared size while streaming. Chunked uploads reserve the
  // hard maximum, so a second upload cannot race the per-farm quota check.
  try {
    await assertBrandStorageCapacity(
      params.farmId,
      Number.isFinite(declaredLength) && declaredLength > 0 ? declaredLength : BRAND_MAX_UPLOAD_BYTES,
    )
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Upload rejected', status: 413 as const }
  }
  activeUploadsByFarm.add(params.farmId)
  const assetId = existing?.id ?? crypto.randomUUID()
  let session: Awaited<ReturnType<typeof createBrandUploadSession>>
  try {
    session = await createBrandUploadSession(params.farmId, assetId)
  } catch (error) {
    activeUploadsByFarm.delete(params.farmId)
    return {
      error: error instanceof Error ? error.message : 'Could not prepare upload',
      status: 500 as const,
    }
  }

  try {
    await streamRequestBodyToFile(params.body, session.sourcePath, BRAND_MAX_UPLOAD_BYTES)
  } catch (error) {
    await removeBrandUploadSession(params.farmId, assetId)
    const message = error instanceof Error ? error.message : 'Upload failed'
    const status = message.includes('too large') ? (413 as const) : (400 as const)
    return { error: message, status }
  } finally {
    activeUploadsByFarm.delete(params.farmId)
  }

  const pendingRelative = `.tmp/${assetId}/source.part`
  // Store absolute path for the worker; validate it stays under farm root
  const abs = resolve(brandFarmRoot(params.farmId), pendingRelative)
  if (!abs.startsWith(`${brandFarmRoot(params.farmId)}/`)) {
    await removeBrandUploadSession(params.farmId, assetId)
    return { error: 'Invalid upload path', status: 400 as const }
  }

  let row: typeof brandAssets.$inferSelect
  if (existing) {
    try {
      const [updated] = await db
        .update(brandAssets)
        .set({
          sourceMimeType: mime,
          // Keep the published status and metadata live until processing succeeds.
          status: existing.filename ? 'ready' : 'processing',
          processingError: null,
          pendingSourcePath: abs,
          pendingOriginalName: originalName || existing.originalName,
          updatedAt: new Date(),
        })
        .where(eq(brandAssets.id, existing.id))
        .returning()
      row = updated!
    } catch (error) {
      await removeBrandUploadSession(params.farmId, assetId).catch(() => undefined)
      throw error
    }
  } else {
    try {
      const [inserted] = await db
        .insert(brandAssets)
        .values({
          id: assetId,
          farmId: params.farmId,
          filename: null,
          originalName: originalName || 'upload',
          mimeType: kind === 'video' ? 'video/mp4' : mime === 'image/heic' || mime === 'image/heif' ? 'image/jpeg' : mime,
          byteSize: null,
          mediaKind: kind,
          status: 'processing',
          sourceMimeType: mime,
          pendingSourcePath: abs,
          pendingOriginalName: originalName || 'upload',
          createdById: params.userId,
        })
        .returning()
      row = inserted!
    } catch (error) {
      await removeBrandUploadSession(params.farmId, assetId).catch(() => undefined)
      throw error
    }
  }

  enqueueBrandAssetProcessing(row.id, params.farmId)
  await logAudit({
    farmId: params.farmId,
    userId: params.userId,
    action: existing ? 'update' : 'create',
    entityType: 'brand_asset',
    entityId: row.id,
    metadata: {
      originalName: row.originalName,
      sourceMimeType: mime,
      streamed: true,
      replaced: Boolean(existing),
    },
  })
  return { asset: serializeAsset(row), status: 202 as const }
}

brandRoutes.post('/assets/upload', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'brand.manage')) return c.json({ error: 'Forbidden' }, 403)
  const result = await beginStreamedUpload({
    farmId: user.farmId,
    userId: user.id,
    contentType: c.req.header('content-type'),
    contentLength: c.req.header('content-length'),
    originalNameHeader: c.req.header('x-brand-original-name') ?? undefined,
    body: c.req.raw.body,
  })
  if ('error' in result) return c.json({ error: result.error }, result.status)
  return c.json({ asset: result.asset }, result.status)
})

brandRoutes.patch('/assets/upload/:id', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'brand.manage')) return c.json({ error: 'Forbidden' }, 403)
  const result = await beginStreamedUpload({
    farmId: user.farmId,
    userId: user.id,
    assetId: c.req.param('id'),
    contentType: c.req.header('content-type'),
    contentLength: c.req.header('content-length'),
    originalNameHeader: c.req.header('x-brand-original-name') ?? undefined,
    body: c.req.raw.body,
    replace: true,
  })
  if ('error' in result) return c.json({ error: result.error }, result.status)
  return c.json({ asset: result.asset }, result.status)
})

brandRoutes.patch('/assets/:id', zValidator('json', mediaSchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'brand.manage')) return c.json({ error: 'Forbidden' }, 403)
  const [existing] = await db
    .select()
    .from(brandAssets)
    .where(and(eq(brandAssets.id, c.req.param('id')), eq(brandAssets.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.status === 'processing' || existing.status === 'uploading') {
    return c.json({ error: 'Asset is still processing' }, 409)
  }
  if (existing.mediaKind === 'video') {
    return c.json({ error: 'Use binary upload to replace video assets' }, 400)
  }

  const body = c.req.valid('json')
  let stored
  try {
    stored = await storeBrandMedia(user.farmId, body.dataUrl)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Upload failed' }, 400)
  }

  const previousFilename = existing.filename
  const originalName = body.originalName?.trim() || existing.originalName
  let row: typeof brandAssets.$inferSelect
  try {
    const [updated] = await db
      .update(brandAssets)
      .set({
        filename: stored.filename,
        originalName,
        mimeType: stored.mimeType,
        byteSize: stored.byteSize,
        mediaKind: 'image',
        status: 'ready',
        sourceMimeType: stored.mimeType,
        processingError: null,
        updatedAt: new Date(),
      })
      .where(eq(brandAssets.id, existing.id))
      .returning()
    row = updated!
  } catch (error) {
    await deleteBrandMedia(user.farmId, stored.filename).catch(() => undefined)
    throw error
  }

  if (previousFilename && previousFilename !== stored.filename) {
    await deleteBrandMedia(user.farmId, previousFilename)
  }
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'brand_asset',
    entityId: existing.id,
    metadata: { originalName, mimeType: stored.mimeType, replaced: true },
  })
  return c.json({ asset: serializeAsset(row) })
})

brandRoutes.get('/assets/:id/media', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'brand.manage')) return c.json({ error: 'Forbidden' }, 403)
  const [row] = await db
    .select()
    .from(brandAssets)
    .where(and(eq(brandAssets.id, c.req.param('id')), eq(brandAssets.farmId, user.farmId)))
    .limit(1)
  if (!row?.filename || row.status !== 'ready') return c.json({ error: 'Not found' }, 404)
  try {
    return await mediaResponse(user.farmId, row.filename, c.req.header('range'), 'private, max-age=3600')
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})

brandRoutes.get('/assets/:id/poster', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'brand.manage')) return c.json({ error: 'Forbidden' }, 403)
  const [row] = await db
    .select()
    .from(brandAssets)
    .where(and(eq(brandAssets.id, c.req.param('id')), eq(brandAssets.farmId, user.farmId)))
    .limit(1)
  if (!row?.posterFilename || row.status !== 'ready') return c.json({ error: 'Not found' }, 404)
  try {
    return await mediaResponse(
      user.farmId,
      row.posterFilename,
      c.req.header('range'),
      'private, max-age=3600',
    )
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})

brandRoutes.delete('/assets/:id', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'brand.manage')) return c.json({ error: 'Forbidden' }, 403)
  const [row] = await db
    .select()
    .from(brandAssets)
    .where(and(eq(brandAssets.id, c.req.param('id')), eq(brandAssets.farmId, user.farmId)))
    .limit(1)
  if (!row) return c.json({ error: 'Not found' }, 404)
  await db.delete(brandAssets).where(eq(brandAssets.id, row.id))
  await deleteBrandMedia(user.farmId, row.filename)
  await deleteBrandMedia(user.farmId, row.posterFilename)
  await removeBrandUploadSession(user.farmId, row.id)
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'brand_asset',
    entityId: row.id,
  })
  return c.json({ ok: true })
})

brandRoutes.get('/packs', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'brand.manage')) return c.json({ error: 'Forbidden' }, 403)
  const packs = await db
    .select()
    .from(brandPacks)
    .where(eq(brandPacks.farmId, user.farmId))
    .orderBy(desc(brandPacks.createdAt))
  const result = []
  for (const pack of packs) {
    result.push(serializePack(pack, await packAssetIds(pack.id)))
  }
  return c.json({ packs: result })
})

brandRoutes.post('/packs', zValidator('json', packSchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'brand.manage')) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const blocked = await assertReadyAssets(user.farmId, body.assetIds)
  if (blocked) return blocked
  const passwordHash =
    body.password && body.password.length > 0 ? await hashPassword(body.password) : null
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null
  const pack = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(brandPacks)
      .values({
        farmId: user.farmId,
        title: body.title,
        notes: body.notes ?? null,
        shareToken: newShareToken(),
        passwordHash,
        expiresAt,
        createdById: user.id,
        updatedById: user.id,
      })
      .returning()
    await replacePackAssets(tx, user.farmId, created!.id, body.assetIds)
    return created!
  })
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'brand_pack',
    entityId: pack.id,
    metadata: { title: pack.title, assetCount: body.assetIds.length },
  })
  return c.json({ pack: serializePack(pack, body.assetIds) }, 201)
})

brandRoutes.patch('/packs/:id', zValidator('json', packSchema.partial()), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'brand.manage')) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const [pack] = await db
    .select()
    .from(brandPacks)
    .where(and(eq(brandPacks.id, c.req.param('id')), eq(brandPacks.farmId, user.farmId)))
    .limit(1)
  if (!pack) return c.json({ error: 'Not found' }, 404)

  if (body.assetIds) {
    const blocked = await assertReadyAssets(user.farmId, body.assetIds)
    if (blocked) return blocked
  }

  let passwordHash = pack.passwordHash
  if (body.clearPassword) passwordHash = null
  else if (body.password && body.password.length > 0) {
    passwordHash = await hashPassword(body.password)
  }

  const updated = await db.transaction(async (tx) => {
    const [changed] = await tx
      .update(brandPacks)
      .set({
        title: body.title ?? pack.title,
        notes: body.notes === undefined ? pack.notes : body.notes,
        passwordHash,
        expiresAt:
          body.expiresAt === undefined
            ? pack.expiresAt
            : body.expiresAt
              ? new Date(body.expiresAt)
              : null,
        updatedById: user.id,
        updatedAt: new Date(),
      })
      .where(eq(brandPacks.id, pack.id))
      .returning()
    if (body.assetIds) {
      await replacePackAssets(tx, user.farmId, pack.id, body.assetIds)
    }
    return changed!
  })

  const assetIds = body.assetIds ?? (await packAssetIds(pack.id))
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'brand_pack',
    entityId: pack.id,
  })
  return c.json({ pack: serializePack(updated, assetIds) })
})

brandRoutes.post('/packs/:id/regenerate-token', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'brand.manage')) return c.json({ error: 'Forbidden' }, 403)
  const [pack] = await db
    .select()
    .from(brandPacks)
    .where(and(eq(brandPacks.id, c.req.param('id')), eq(brandPacks.farmId, user.farmId)))
    .limit(1)
  if (!pack) return c.json({ error: 'Not found' }, 404)
  const [updated] = await db
    .update(brandPacks)
    .set({
      shareToken: newShareToken(),
      updatedById: user.id,
      updatedAt: new Date(),
    })
    .where(eq(brandPacks.id, pack.id))
    .returning()
  return c.json({ pack: serializePack(updated!, await packAssetIds(pack.id)) })
})

brandRoutes.post('/packs/:id/revoke', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'brand.manage')) return c.json({ error: 'Forbidden' }, 403)
  const [pack] = await db
    .select()
    .from(brandPacks)
    .where(and(eq(brandPacks.id, c.req.param('id')), eq(brandPacks.farmId, user.farmId)))
    .limit(1)
  if (!pack) return c.json({ error: 'Not found' }, 404)
  const [updated] = await db
    .update(brandPacks)
    .set({
      revokedAt: new Date(),
      updatedById: user.id,
      updatedAt: new Date(),
    })
    .where(eq(brandPacks.id, pack.id))
    .returning()
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'brand_pack',
    entityId: pack.id,
    metadata: { revoked: true },
  })
  return c.json({ pack: serializePack(updated!, await packAssetIds(pack.id)) })
})

brandRoutes.delete('/packs/:id', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'brand.manage')) return c.json({ error: 'Forbidden' }, 403)
  const [pack] = await db
    .select()
    .from(brandPacks)
    .where(and(eq(brandPacks.id, c.req.param('id')), eq(brandPacks.farmId, user.farmId)))
    .limit(1)
  if (!pack) return c.json({ error: 'Not found' }, 404)
  await db.delete(brandPacks).where(eq(brandPacks.id, pack.id))
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'brand_pack',
    entityId: pack.id,
  })
  return c.json({ ok: true })
})

async function loadActivePackByToken(token: string) {
  const [pack] = await db
    .select()
    .from(brandPacks)
    .where(eq(brandPacks.shareToken, token))
    .limit(1)
  if (!pack || !packIsActive(pack)) return null
  return pack
}

async function publicRateLimited(c: Context) {
  const ip = clientIpFromHeaders((name) => c.req.header(name))
  if (!(await checkDurableRateLimit(`brand-public:${ip}`, PUBLIC_RATE.max, PUBLIC_RATE.windowMs)).allowed) {
    return c.json({ error: 'Too many requests' }, 429)
  }
  return null
}

function hasPackSession(c: { req: { header: (n: string) => string | undefined } }, packId: string) {
  return verifyBrandPackSessionToken(
    getCookie(c as never, brandPackSessionCookieName(packId)),
    packId,
  )
}

publicBrandRoutes.get('/:token', async (c) => {
  const limited = await publicRateLimited(c)
  if (limited) return limited
  const pack = await loadActivePackByToken(c.req.param('token'))
  if (!pack) return c.json({ error: 'Not found' }, 404)
  const unlocked = hasPackSession(c, pack.id) || !pack.passwordHash
  return c.json({
    title: pack.title,
    notes: pack.notes,
    passwordRequired: Boolean(pack.passwordHash),
    unlocked,
    expiresAt: pack.expiresAt?.toISOString() ?? null,
  })
})

publicBrandRoutes.post('/:token/unlock', zValidator('json', unlockSchema), async (c) => {
  const limited = await publicRateLimited(c)
  if (limited) return limited
  const token = c.req.param('token')
  const pack = await loadActivePackByToken(token)
  if (!pack) return c.json({ error: 'Not found' }, 404)

  const ip = clientIpFromHeaders((name) => c.req.header(name))
  const unlockKey = hashedRateKey('brand:unlock', `${token}:${ip}`)
  if (!(await checkDurableRateLimit(unlockKey, UNLOCK_MAX, UNLOCK_WINDOW_MS)).allowed) {
    return c.json({ error: 'Too many unlock attempts. Try again later.' }, 429)
  }

  const body = c.req.valid('json')
  if (pack.passwordHash) {
    const ok = await verifyPassword(pack.passwordHash, body.password ?? '')
    if (!ok) return c.json({ error: 'Incorrect password' }, 401)
  }

  let session
  try {
    session = createBrandPackSessionToken(pack.id, pack.expiresAt)
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
  const secure = (c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol).includes('https')
  setCookie(
    c,
    brandPackSessionCookieName(pack.id),
    session.token,
    brandPackSessionCookieOptions(secure, session.maxAgeSec),
  )

  await db
    .update(brandPacks)
    .set({ viewCount: sql`${brandPacks.viewCount} + 1` })
    .where(eq(brandPacks.id, pack.id))

  return c.json({ ok: true, title: pack.title })
})

publicBrandRoutes.get('/:token/items', async (c) => {
  const limited = await publicRateLimited(c)
  if (limited) return limited
  const pack = await loadActivePackByToken(c.req.param('token'))
  if (!pack) return c.json({ error: 'Not found' }, 404)
  if (pack.passwordHash && !hasPackSession(c, pack.id)) {
    return c.json({ error: 'Unlock required' }, 401)
  }
  if (!pack.passwordHash && !hasPackSession(c, pack.id)) {
    let session
    try {
      session = createBrandPackSessionToken(pack.id, pack.expiresAt)
    } catch {
      return c.json({ error: 'Not found' }, 404)
    }
    const secure = (c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol).includes(
      'https',
    )
    setCookie(
      c,
      brandPackSessionCookieName(pack.id),
      session.token,
      brandPackSessionCookieOptions(secure, session.maxAgeSec),
    )
    await db
      .update(brandPacks)
      .set({ viewCount: sql`${brandPacks.viewCount} + 1` })
      .where(eq(brandPacks.id, pack.id))
  }

  const rows = await db
    .select({
      id: brandAssets.id,
      originalName: brandAssets.originalName,
      mimeType: brandAssets.mimeType,
      byteSize: brandAssets.byteSize,
      width: brandAssets.width,
      height: brandAssets.height,
      mediaKind: brandAssets.mediaKind,
      durationSeconds: brandAssets.durationSeconds,
      posterFilename: brandAssets.posterFilename,
      status: brandAssets.status,
    })
    .from(brandPackAssets)
    .innerJoin(brandAssets, eq(brandPackAssets.assetId, brandAssets.id))
    .where(eq(brandPackAssets.packId, pack.id))
    .orderBy(asc(brandPackAssets.position))

  const token = c.req.param('token')
  return c.json({
    title: pack.title,
    notes: pack.notes,
    items: rows
      .filter((row) => row.status === 'ready')
      .map((row) => ({
        id: row.id,
        originalName: row.originalName,
        mimeType: row.mimeType,
        mediaKind: row.mediaKind,
        byteSize: row.byteSize,
        width: row.width,
        height: row.height,
        durationSeconds: row.durationSeconds,
        mediaUrl: `/${token}/media/${row.id}`,
        posterUrl: row.posterFilename ? `/${token}/media/${row.id}/poster` : null,
      })),
  })
})

publicBrandRoutes.get('/:token/media/:assetId/poster', async (c) => {
  const limited = await publicRateLimited(c)
  if (limited) return limited
  const pack = await loadActivePackByToken(c.req.param('token'))
  if (!pack) return c.json({ error: 'Not found' }, 404)
  if (pack.passwordHash && !hasPackSession(c, pack.id)) {
    return c.json({ error: 'Unlock required' }, 401)
  }
  const [row] = await db
    .select({
      posterFilename: brandAssets.posterFilename,
      farmId: brandAssets.farmId,
      status: brandAssets.status,
    })
    .from(brandPackAssets)
    .innerJoin(brandAssets, eq(brandPackAssets.assetId, brandAssets.id))
    .where(
      and(
        eq(brandPackAssets.packId, pack.id),
        eq(brandPackAssets.assetId, c.req.param('assetId')),
      ),
    )
    .limit(1)
  if (!row?.posterFilename || row.status !== 'ready') return c.json({ error: 'Not found' }, 404)
  try {
    return await mediaResponse(
      row.farmId,
      row.posterFilename,
      c.req.header('range'),
      'private, max-age=300',
    )
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})

publicBrandRoutes.get('/:token/media/:assetId', async (c) => {
  const limited = await publicRateLimited(c)
  if (limited) return limited
  const pack = await loadActivePackByToken(c.req.param('token'))
  if (!pack) return c.json({ error: 'Not found' }, 404)
  if (pack.passwordHash && !hasPackSession(c, pack.id)) {
    return c.json({ error: 'Unlock required' }, 401)
  }
  const [row] = await db
    .select({
      filename: brandAssets.filename,
      farmId: brandAssets.farmId,
      mimeType: brandAssets.mimeType,
      status: brandAssets.status,
    })
    .from(brandPackAssets)
    .innerJoin(brandAssets, eq(brandPackAssets.assetId, brandAssets.id))
    .where(
      and(
        eq(brandPackAssets.packId, pack.id),
        eq(brandPackAssets.assetId, c.req.param('assetId')),
      ),
    )
    .limit(1)
  if (!row?.filename || row.status !== 'ready') return c.json({ error: 'Not found' }, 404)
  try {
    return await mediaResponse(row.farmId, row.filename, c.req.header('range'), 'private, max-age=300')
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})

publicBrandRoutes.get('/:token/download.zip', async (c) => {
  const limited = await publicRateLimited(c)
  if (limited) return limited
  const pack = await loadActivePackByToken(c.req.param('token'))
  if (!pack) return c.json({ error: 'Not found' }, 404)
  if (pack.passwordHash && !hasPackSession(c, pack.id)) {
    return c.json({ error: 'Unlock required' }, 401)
  }
  if (!pack.passwordHash && !hasPackSession(c, pack.id)) {
    let session
    try {
      session = createBrandPackSessionToken(pack.id, pack.expiresAt)
    } catch {
      return c.json({ error: 'Not found' }, 404)
    }
    const secure = (c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol).includes(
      'https',
    )
    setCookie(
      c,
      brandPackSessionCookieName(pack.id),
      session.token,
      brandPackSessionCookieOptions(secure, session.maxAgeSec),
    )
  }

  const rows = await db
    .select({
      filename: brandAssets.filename,
      originalName: brandAssets.originalName,
      farmId: brandAssets.farmId,
      status: brandAssets.status,
      mimeType: brandAssets.mimeType,
    })
    .from(brandPackAssets)
    .innerJoin(brandAssets, eq(brandPackAssets.assetId, brandAssets.id))
    .where(eq(brandPackAssets.packId, pack.id))
    .orderBy(asc(brandPackAssets.position))

  const entries = []
  for (const row of rows) {
    if (row.status !== 'ready' || !row.filename) continue
    const path = brandMediaAbsolutePath(row.farmId, row.filename)
    let name = row.originalName
    if (row.mimeType === 'video/mp4' && !name.toLowerCase().endsWith('.mp4')) {
      const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name
      name = `${stem}.mp4`
    }
    entries.push({ name, path })
  }

  await db
    .update(brandPacks)
    .set({ downloadCount: sql`${brandPacks.downloadCount} + 1` })
    .where(eq(brandPacks.id, pack.id))

  const safeTitle = pack.title.replace(/[^\w.\- ]+/g, '_').slice(0, 60) || 'brand-pack'
  const zipStream = createStoredZipStream(entries)
  return new Response(Readable.toWeb(zipStream) as ReadableStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeTitle}.zip"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})
