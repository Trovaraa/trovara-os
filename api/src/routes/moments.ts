import { zValidator } from '@hono/zod-validator'
import { and, count, desc, eq, inArray, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { createReadStream } from 'node:fs'
import { stat, writeFile, mkdir } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { db } from '../db/index.js'
import { momentSubmissions, users } from '../db/schema.js'
import { logAudit } from '../lib/audit.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import { resolveCustomerFarm } from '../lib/customer-orders.js'
import {
  escapeEmailHtml,
  emailLayout,
  emailDetailRows,
  emailButton,
} from '../lib/email-template.js'
import { sendEmail } from '../lib/notifications.js'
import { checkRateLimit } from '../lib/rate-limit.js'
import { getBreakGlassEmail } from '../lib/registration.js'
import { hasPermission } from '../lib/rbac.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { notifyRolesTelegram } from '../lib/farm-notify.js'
import { getEvidenceStorageRoot } from '../lib/evidence-store.js'
import type { SessionUser } from '../lib/session.js'

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 // 50MB

const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])

const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
])

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
}

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
}

function normalizeMediaMime(mime: string | undefined, filename?: string): string | null {
  const lower = mime?.trim().toLowerCase()
  if (!lower) {
    if (!filename) return null
    const ext = extname(filename).slice(1).toLowerCase()
    return EXT_TO_MIME[ext] || null
  }
  if (ALLOWED_IMAGE_MIMES.has(lower) || ALLOWED_VIDEO_MIMES.has(lower)) {
    return lower
  }
  return null
}

function mediaKindForMime(mime: string): 'image' | 'video' | null {
  if (ALLOWED_IMAGE_MIMES.has(mime)) return 'image'
  if (ALLOWED_VIDEO_MIMES.has(mime)) return 'video'
  return null
}

function momentsStoragePath(farmId: string): string {
  return join(getEvidenceStorageRoot(), 'moments', farmId)
}

async function storeMomentMedia(
  farmId: string,
  buffer: Buffer,
  mime: string,
): Promise<{ storageKey: string; byteSize: number }> {
  const ext = MIME_TO_EXT[mime]
  if (!ext) throw new Error('Unsupported media type')
  
  const filename = `${randomBytes(16).toString('base64url')}.${ext}`
  const dir = momentsStoragePath(farmId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, filename)
  await writeFile(path, buffer)
  
  return {
    storageKey: `moments/${farmId}/${filename}`,
    byteSize: buffer.length,
  }
}

const uploadSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().max(320).optional(),
  consent: z.literal(true),
  honey: z.string().max(500).optional(),
}).strict()

const statusSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
})

const reviewSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  reviewNote: z.string().trim().max(500).optional(),
}).strict()

type MomentSubmission = typeof momentSubmissions.$inferSelect

const PUBLIC_ACCEPTED = { ok: true, accepted: true }

export const publicMomentsRoutes = new Hono()
export const momentsRoutes = new Hono<{ Variables: AppVariables }>()
momentsRoutes.use('*', authMiddleware)

function publicRateLimit(c: { req: { header: (name: string) => string | undefined }; header: (name: string, value: string) => void }, action: string): boolean {
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const result = checkRateLimit(`moments:${action}:${ip}`, 5, 60_000)
  if (!result.allowed) c.header('Retry-After', String(result.retryAfterSec))
  return result.allowed
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .slice(0, 1000)
}

function momentsAdminUrl(): string {
  const base = process.env.PUBLIC_APP_URL?.trim() || 'https://os.trovara.farm'
  try {
    return new URL('/moments', base).toString()
  } catch {
    return 'https://os.trovara.farm/moments'
  }
}

function momentNotificationHtml(moment: MomentSubmission): string {
  const contact = moment.submitterEmail || moment.submitterName || 'Anonymous'
  
  return emailLayout({
    badge: 'NEW MOMENTS UPLOAD',
    headline: 'A new moment was submitted',
    intro: 'Review and approve or reject this submission.',
    preheader: `New ${moment.mediaKind} submission from ${contact}`,
    body: emailDetailRows([
      { label: 'From', valueHtml: escapeEmailHtml(contact) },
      { label: 'Type', valueHtml: escapeEmailHtml(moment.mediaKind) },
      { label: 'Size', valueHtml: `${Math.round(moment.byteSize / 1024)} KB` },
      { label: 'Submitted', valueHtml: moment.createdAt.toLocaleString() },
    ]) + emailButton(momentsAdminUrl(), 'Review Now'),
  })
}

async function notifyMomentSubmission(moment: MomentSubmission): Promise<void> {
  const [emailRecipients] = await Promise.all([
    db
      .select({ email: users.email })
      .from(users)
      .where(
        and(
          eq(users.farmId, moment.farmId),
          eq(users.active, true),
          inArray(users.role, ['owner', 'supervisor']),
          ne(users.email, getBreakGlassEmail()),
        ),
      ),
    notifyRolesTelegram(moment.farmId, ['owner', 'supervisor'], 'New Moments upload awaiting review.'),
  ])

  const subject = 'New Moments submission awaiting review'
  const contact = moment.submitterEmail || moment.submitterName || 'Anonymous'
  const text = [
    `From: ${contact}`,
    `Type: ${moment.mediaKind}`,
    `Size: ${Math.round(moment.byteSize / 1024)} KB`,
    `Review at: ${momentsAdminUrl()}`,
  ].join('\n\n')
  const html = momentNotificationHtml(moment)

  await Promise.all(
    emailRecipients.map(({ email }) =>
      sendEmail({ to: email, subject, text, html }).catch(() => undefined)
    )
  )
}

// Public routes

publicMomentsRoutes.get('/', async (c) => {
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Service unavailable' }, 503)

  const moments = await db
    .select({
      id: momentSubmissions.id,
      mediaKind: momentSubmissions.mediaKind,
      mimeType: momentSubmissions.mimeType,
      storageKey: momentSubmissions.storageKey,
      durationSeconds: momentSubmissions.durationSeconds,
      createdAt: momentSubmissions.createdAt,
    })
    .from(momentSubmissions)
    .where(
      and(
        eq(momentSubmissions.farmId, farm.id),
        eq(momentSubmissions.status, 'approved')
      )
    )
    .orderBy(desc(momentSubmissions.createdAt))
    .limit(100)

  return c.json({
    moments: moments.map((m) => ({
      id: m.id,
      mediaKind: m.mediaKind,
      mimeType: m.mimeType,
      durationSeconds: m.durationSeconds,
      mediaUrl: `/public/moments/${m.id}/media`,
      createdAt: m.createdAt.toISOString(),
    })),
  })
})

publicMomentsRoutes.get('/:id/media', async (c) => {
  const [moment] = await db
    .select()
    .from(momentSubmissions)
    .where(
      and(
        eq(momentSubmissions.id, c.req.param('id')),
        eq(momentSubmissions.status, 'approved')
      )
    )
    .limit(1)

  if (!moment?.storageKey || moment.status !== 'approved') {
    return c.json({ error: 'Not found' }, 404)
  }

  const filePath = join(getEvidenceStorageRoot(), moment.storageKey)
  try {
    const stats = await stat(filePath)
    const stream = createReadStream(filePath)
    return new Response(stream as any, {
      headers: {
        'Content-Type': moment.mimeType,
        'Content-Length': String(stats.size),
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})

publicMomentsRoutes.post('/', async (c) => {
  if (!publicRateLimit(c, 'upload')) {
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }

  const contentType = c.req.header('content-type')
  const isMultipart = contentType?.includes('multipart/form-data')

  let parsedBody: z.infer<typeof uploadSchema>
  let fileBuffer: Buffer | null = null
  let fileMime: string | null = null
  let originalFilename: string | undefined

  if (isMultipart) {
    const formData = await c.req.formData()
    const fields = {
      name: formData.get('name') as string | null,
      email: formData.get('email') as string | null,
      consent: formData.get('consent') === 'true',
      honey: formData.get('honey') as string | null,
    }
    
    const file = formData.get('file') as File | null
    if (!file) return c.json({ error: 'File is required' }, 400)
    
    originalFilename = file.name
    fileMime = normalizeMediaMime(file.type, originalFilename)
    if (!fileMime) return c.json({ error: 'Unsupported file type' }, 415)
    
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: 'File too large (max 50MB)' }, 413)
    }
    
    fileBuffer = Buffer.from(await file.arrayBuffer())
    
    const validation = uploadSchema.safeParse({
      name: fields.name || undefined,
      email: fields.email || undefined,
      consent: fields.consent,
      honey: fields.honey || undefined,
    })
    
    if (!validation.success) {
      return c.json({ error: 'Invalid submission', details: validation.error.flatten() }, 400)
    }
    parsedBody = validation.data
  } else {
    return c.json({ error: 'Multipart form-data required' }, 400)
  }

  if (parsedBody.honey?.trim()) return c.json(PUBLIC_ACCEPTED, 202)

  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Form service is temporarily unavailable.' }, 503)

  if (!fileMime || !fileBuffer) {
    return c.json({ error: 'Invalid file upload' }, 400)
  }

  const mediaKind = mediaKindForMime(fileMime)
  if (!mediaKind) return c.json({ error: 'Unsupported media type' }, 415)

  try {
    const stored = await storeMomentMedia(farm.id, fileBuffer, fileMime)
    
    const [moment] = await db.insert(momentSubmissions).values({
      farmId: farm.id,
      status: 'pending',
      submitterName: parsedBody.name || null,
      submitterEmail: parsedBody.email || null,
      consent: parsedBody.consent,
      mediaKind,
      mimeType: fileMime,
      originalFilename,
      storageKey: stored.storageKey,
      byteSize: stored.byteSize,
    }).returning()

    void notifyMomentSubmission(moment).catch((error) => {
      console.warn('Moment notification failed:', safeError(error))
    })

    return c.json(PUBLIC_ACCEPTED, 202)
  } catch (error) {
    console.error('Moment upload failed:', safeError(error))
    return c.json({ error: 'Upload failed' }, 500)
  }
})

// Admin routes

function canManageMoments(user: SessionUser): boolean {
  return hasPermission(user, 'moments.manage')
}

momentsRoutes.get('/', zValidator('query', statusSchema), async (c) => {
  const user = c.get('user')
  if (!canManageMoments(user)) return c.json({ error: 'Forbidden' }, 403)

  const query = c.req.valid('query')
  const filters = [eq(momentSubmissions.farmId, user.farmId)]
  if (query.status) filters.push(eq(momentSubmissions.status, query.status))

  const moments = await db
    .select()
    .from(momentSubmissions)
    .where(and(...filters))
    .orderBy(desc(momentSubmissions.createdAt))
    .limit(500)

  const countRows = await db
    .select({ status: momentSubmissions.status, count: count() })
    .from(momentSubmissions)
    .where(eq(momentSubmissions.farmId, user.farmId))
    .groupBy(momentSubmissions.status)
  const summary = { total: 0, pending: 0, approved: 0, rejected: 0 }
  for (const row of countRows) {
    if (row.status === 'pending' || row.status === 'approved' || row.status === 'rejected') {
      const value = Number(row.count)
      summary[row.status] = value
      summary.total += value
    }
  }

  return c.json({
    summary,
    moments: moments.map((m) => ({
      id: m.id,
      status: m.status,
      submitterName: m.submitterName,
      submitterEmail: m.submitterEmail,
      mediaKind: m.mediaKind,
      mimeType: m.mimeType,
      originalFilename: m.originalFilename,
      byteSize: m.byteSize,
      durationSeconds: m.durationSeconds,
      reviewNote: m.reviewNote,
      reviewedById: m.reviewedById,
      reviewedAt: m.reviewedAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
      mediaUrl: `/api/moments/${m.id}/media`,
    })),
  })
})

momentsRoutes.patch('/:id', zValidator('json', reviewSchema), async (c) => {
  const user = c.get('user')
  if (!canManageMoments(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const [existing] = await db
    .select()
    .from(momentSubmissions)
    .where(
      and(
        eq(momentSubmissions.id, c.req.param('id')),
        eq(momentSubmissions.farmId, user.farmId)
      )
    )
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  const [updated] = await db
    .update(momentSubmissions)
    .set({
      status: body.status,
      reviewNote: body.reviewNote || null,
      reviewedById: user.id,
      reviewedAt: new Date(),
    })
    .where(
      and(
        eq(momentSubmissions.id, existing.id),
        eq(momentSubmissions.farmId, user.farmId)
      )
    )
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'moment_submission',
    entityId: updated.id,
    metadata: {
      status: { from: existing.status, to: body.status },
      reviewNote: body.reviewNote,
    },
  })

  return c.json({ moment: updated })
})

momentsRoutes.get('/:id/media', async (c) => {
  const user = c.get('user')
  if (!canManageMoments(user)) return c.json({ error: 'Forbidden' }, 403)

  const [moment] = await db
    .select()
    .from(momentSubmissions)
    .where(
      and(
        eq(momentSubmissions.id, c.req.param('id')),
        eq(momentSubmissions.farmId, user.farmId)
      )
    )
    .limit(1)

  if (!moment?.storageKey) return c.json({ error: 'Not found' }, 404)

  const filePath = join(getEvidenceStorageRoot(), moment.storageKey)
  try {
    const stats = await stat(filePath)
    const stream = createReadStream(filePath)
    return new Response(stream as any, {
      headers: {
        'Content-Type': moment.mimeType,
        'Content-Length': String(stats.size),
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})
