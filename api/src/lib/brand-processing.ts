import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { copyFile } from 'node:fs/promises'
import { db } from '../db/index.js'
import { brandAssets } from '../db/schema.js'
import {
  deleteBrandMedia,
  promoteBrandFile,
  removeBrandUploadSession,
  writeBrandPosterFromFile,
} from './brand-media.js'
import { transcodeBrandUpload } from './brand-transcode.js'

type QueueItem = { assetId: string; farmId: string }

const queue: QueueItem[] = []
const queuedIds = new Set<string>()
let active: Promise<void> | null = null
let started = false

export function enqueueBrandAssetProcessing(assetId: string, farmId: string): void {
  if (queuedIds.has(assetId)) return
  queuedIds.add(assetId)
  queue.push({ assetId, farmId })
  void pumpQueue()
}

async function pumpQueue(): Promise<void> {
  if (active) return
  active = (async () => {
    while (queue.length) {
      const next = queue.shift()!
      queuedIds.delete(next.assetId)
      try {
        await processBrandAsset(next.assetId, next.farmId)
      } catch (error) {
        console.error(
          'Brand asset processing failed:',
          next.assetId,
          error instanceof Error ? error.message : error,
        )
      }
    }
  })().finally(() => {
    active = null
    if (queue.length) void pumpQueue()
  })
  await active
}

export async function processBrandAsset(assetId: string, farmId: string): Promise<void> {
  const [candidate] = await db
    .select()
    .from(brandAssets)
    .where(and(eq(brandAssets.id, assetId), eq(brandAssets.farmId, farmId)))
    .limit(1)
  if (!candidate) return
  // Replacements deliberately remain ready so the previous file stays live.
  if (
    candidate.status !== 'processing' &&
    candidate.status !== 'uploading' &&
    !(candidate.status === 'ready' && candidate.pendingSourcePath)
  ) return
  const pendingPath = candidate.pendingSourcePath
  const pendingMime = candidate.sourceMimeType
  if (!pendingPath || !pendingMime) {
    await markFailed(assetId, farmId, 'Missing uploaded source file')
    return
  }
  const leaseToken = randomUUID()
  const now = new Date()
  const [row] = await db
    .update(brandAssets)
    .set({
      processingLeaseToken: leaseToken,
      processingLeaseExpiresAt: new Date(now.getTime() + 20 * 60 * 1000),
      processingError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(brandAssets.id, assetId),
        eq(brandAssets.farmId, farmId),
        eq(brandAssets.pendingSourcePath, pendingPath),
        or(
          isNull(brandAssets.processingLeaseExpiresAt),
          lt(brandAssets.processingLeaseExpiresAt, now),
        ),
      ),
    )
    .returning()
  if (!row) return
  const sourcePath = pendingPath
  const sourceMime = pendingMime

  const previousFilename = row.filename
  const previousPoster = row.posterFilename
  let promotedFilename: string | null = null
  let promotedPoster: string | null = null

  try {
    if (!previousFilename) {
      await db
        .update(brandAssets)
        .set({ status: 'processing', processingError: null, updatedAt: new Date() })
        .where(eq(brandAssets.id, assetId))
    }

    const result = await transcodeBrandUpload({
      sourcePath,
      sessionDir: sourcePath.replace(/\/[^/]+$/, ''),
      sourceMime,
    })

    let promotePath = result.outputPath
    if (result.passThrough && result.outputPath === sourcePath) {
      // Keep source; promoteBrandFile will rename it into the final library name.
      promotePath = sourcePath
    } else if (result.passThrough) {
      promotePath = result.outputPath
    } else if (result.outputPath === sourcePath) {
      promotePath = sourcePath
    } else {
      // Ensure we don't lose the source until promote succeeds: copy if same device issues
      promotePath = result.outputPath
    }

    // For SVG/JPEG passthrough where output is the source.part path, promote renames it.
    const stored = await promoteBrandFile(farmId, promotePath, result.mimeType)
    promotedFilename = stored.filename
    let posterFilename: string | null = null
    if (result.posterPath) {
      posterFilename = await writeBrandPosterFromFile(farmId, result.posterPath)
      promotedPoster = posterFilename
    }

    const updated = await db
      .update(brandAssets)
      .set({
        filename: stored.filename,
        originalName: row.pendingOriginalName || row.originalName,
        mimeType: stored.mimeType,
        byteSize: stored.byteSize,
        width: result.width,
        height: result.height,
        durationSeconds: result.durationSeconds,
        posterFilename,
        mediaKind: stored.mimeType.startsWith('video/') ? 'video' : 'image',
        status: 'ready',
        processingError: null,
        pendingSourcePath: null,
        pendingOriginalName: null,
        processingLeaseToken: null,
        processingLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(brandAssets.id, assetId),
          eq(brandAssets.farmId, farmId),
          eq(brandAssets.pendingSourcePath, sourcePath),
          eq(brandAssets.processingLeaseToken, leaseToken),
        ),
      )
      .returning({ id: brandAssets.id })
    if (updated.length !== 1) {
      throw new Error('Brand processing lease was lost')
    }
    promotedFilename = null
    promotedPoster = null

    // On replace, drop previous published files after the new ones are live.
    if (previousFilename && previousFilename !== stored.filename) {
      await deleteBrandMedia(farmId, previousFilename)
    }
    if (previousPoster && previousPoster !== posterFilename) {
      await deleteBrandMedia(farmId, previousPoster)
    }

    await removeBrandUploadSession(farmId, assetId)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Processing failed'
    await Promise.all([
      deleteBrandMedia(farmId, promotedFilename).catch(() => undefined),
      deleteBrandMedia(farmId, promotedPoster).catch(() => undefined),
    ])
    await markFailed(assetId, farmId, message, Boolean(previousFilename), leaseToken)
    await removeBrandUploadSession(farmId, assetId).catch(() => undefined)
    throw error
  }
}

async function markFailed(
  assetId: string,
  farmId: string,
  message: string,
  preservePublished = false,
  leaseToken?: string,
): Promise<void> {
  await db
    .update(brandAssets)
    .set({
      status: preservePublished ? 'ready' : 'failed',
      processingError: message.slice(0, 500),
      pendingSourcePath: null,
      pendingOriginalName: null,
      processingLeaseToken: null,
      processingLeaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(brandAssets.id, assetId),
        eq(brandAssets.farmId, farmId),
        ...(leaseToken ? [eq(brandAssets.processingLeaseToken, leaseToken)] : []),
      ),
    )
}

/** Resume interrupted jobs after API restart. */
export async function resumeBrandAssetProcessing(): Promise<void> {
  if (started) return
  started = true
  const rows = await db
    .select({ id: brandAssets.id, farmId: brandAssets.farmId })
    .from(brandAssets)
    .where(inArray(brandAssets.status, ['processing', 'uploading', 'ready']))
  for (const row of rows) {
    if (!row.id) continue
    // uploading without a finished stream should fail; processing with pending path resumes
    const [full] = await db
      .select()
      .from(brandAssets)
      .where(eq(brandAssets.id, row.id))
      .limit(1)
    if (!full?.pendingSourcePath) {
      if (full?.status === 'ready') continue
      await markFailed(row.id, row.farmId, 'Upload interrupted before processing')
      continue
    }
    enqueueBrandAssetProcessing(row.id, row.farmId)
  }
}

/** Test helper: copy a fixture into an upload session path. */
export async function copyIntoPending(source: string, dest: string): Promise<void> {
  await copyFile(source, dest)
}
