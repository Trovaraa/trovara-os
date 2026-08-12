import { zValidator } from '@hono/zod-validator'
import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
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
import { checkDurableRateLimit } from '../lib/rate-limit.js'
import { getBreakGlassEmail } from '../lib/registration.js'
import { hasPermission } from '../lib/rbac.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { notifyRolesTelegram } from '../lib/farm-notify.js'
import type { SessionUser } from '../lib/session.js'
import {
  deleteMomentMedia,
  hasMomentMediaSignature,
  MOMENTS_MAX_UPLOAD_BYTES,
  momentMediaKind,
  momentMediaResponse,
  normalizeMomentMediaMime,
  storeMomentMedia,
} from '../lib/moments-media.js'

const MOMENTS_PENDING_MAX_COUNT = 500
const MOMENTS_PENDING_MAX_BYTES = 512 * 1024 * 1024
const MOMENTS_CONSENT_VERSION = process.env.MOMENTS_CONSENT_VERSION?.trim() || '2026-08-11'

const uploadSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().max(320).optional(),
  description: z.string().trim().min(1).max(300),
  consent: z.literal(true),
  consentVersion: z.string().trim().min(1).max(40),
  honey: z.string().max(500).optional(),
}).strict()

const statusSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
})

const reviewSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  reviewNote: z.string().trim().max(500).optional(),
  groupLabel: z.string().trim().min(1).max(80).nullable().optional(),
}).strict()

type MomentSubmission = typeof momentSubmissions.$inferSelect

const PUBLIC_ACCEPTED = { ok: true, accepted: true }

export const publicMomentsRoutes = new Hono()
export const momentsRoutes = new Hono<{ Variables: AppVariables }>()
momentsRoutes.use('*', authMiddleware)

async function publicRateLimit(c: { req: { header: (name: string) => string | undefined }; header: (name: string, value: string) => void }, action: string, max = 5): Promise<boolean> {
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const result = await checkDurableRateLimit(`moments:${action}:${ip}`, max, 60_000)
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
      description: momentSubmissions.description,
      groupLabel: momentSubmissions.groupLabel,
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
      description: m.description,
      groupLabel: m.groupLabel,
      mediaUrl: `/public/moments/${m.id}/media`,
      createdAt: m.createdAt.toISOString(),
    })),
  })
})

publicMomentsRoutes.get('/:id/media', async (c) => {
  if (!(await publicRateLimit(c, 'media', 120))) {
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Not found' }, 404)

  const [moment] = await db
    .select()
    .from(momentSubmissions)
    .where(
      and(
        eq(momentSubmissions.id, c.req.param('id')),
        eq(momentSubmissions.farmId, farm.id),
        eq(momentSubmissions.status, 'approved')
      )
    )
    .limit(1)

  if (!moment?.storageKey || moment.status !== 'approved') {
    return c.json({ error: 'Not found' }, 404)
  }

  try {
    return await momentMediaResponse({
      farmId: farm.id,
      storageKey: moment.storageKey,
      mimeType: moment.mimeType,
      rangeHeader: c.req.header('range'),
      cacheControl: 'public, max-age=86400',
    })
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})

publicMomentsRoutes.post('/', async (c) => {
  if (!(await publicRateLimit(c, 'upload'))) {
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }

  const contentType = c.req.header('content-type')
  const isMultipart = contentType?.includes('multipart/form-data')
  const requestLength = Number(c.req.header('content-length'))
  if (Number.isFinite(requestLength) && requestLength > MOMENTS_MAX_UPLOAD_BYTES) {
    return c.json({ error: 'Payload too large (max 12MB)' }, 413)
  }

  let parsedBody: z.infer<typeof uploadSchema>
  let fileBuffer: Buffer | null = null
  let fileMime: string | null = null
  let originalFilename: string | undefined

  if (isMultipart) {
    const formData = await c.req.formData()
    const fields = {
      name: formData.get('name') as string | null,
      email: formData.get('email') as string | null,
      description: formData.get('description') as string | null,
      consent: formData.get('consent') === 'true',
      consentVersion: formData.get('consentVersion') as string | null,
      honey: formData.get('honey') as string | null,
    }
    
    const file = formData.get('file') as File | null
    if (!file) return c.json({ error: 'File is required' }, 400)
    
    originalFilename = file.name
    fileMime = normalizeMomentMediaMime(file.type, originalFilename)
    if (!fileMime) return c.json({ error: 'Unsupported file type' }, 415)
    
    if (file.size > MOMENTS_MAX_UPLOAD_BYTES) {
      return c.json({ error: 'File too large (max 12MB)' }, 413)
    }
    
    fileBuffer = Buffer.from(await file.arrayBuffer())
    
    const validation = uploadSchema.safeParse({
      name: fields.name || undefined,
      email: fields.email || undefined,
      description: fields.description || '',
      consent: fields.consent,
      consentVersion: fields.consentVersion || '',
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
  if (parsedBody.consentVersion !== MOMENTS_CONSENT_VERSION) {
    return c.json({ error: 'The privacy notice changed. Refresh and consent again.' }, 409)
  }

  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Form service is temporarily unavailable.' }, 503)

  if (!fileMime || !fileBuffer) {
    return c.json({ error: 'Invalid file upload' }, 400)
  }

  if (!hasMomentMediaSignature(fileMime, fileBuffer)) {
    return c.json({ error: 'File content does not match its media type' }, 415)
  }
  const mediaKind = momentMediaKind(fileMime)
  if (!mediaKind) return c.json({ error: 'Unsupported media type' }, 415)

  const [quota] = await db
    .select({
      count: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${momentSubmissions.byteSize}), 0)::bigint`,
    })
    .from(momentSubmissions)
    .where(
      and(
        eq(momentSubmissions.farmId, farm.id),
        inArray(momentSubmissions.status, ['pending', 'rejected']),
      ),
    )
  if (
    Number(quota?.count ?? 0) >= MOMENTS_PENDING_MAX_COUNT ||
    Number(quota?.bytes ?? 0) + fileBuffer.length > MOMENTS_PENDING_MAX_BYTES
  ) {
    return c.json({ error: 'Moment submission storage quota reached' }, 429)
  }

  let stored: Awaited<ReturnType<typeof storeMomentMedia>> | null = null
  try {
    stored = await storeMomentMedia(farm.id, fileBuffer, fileMime)
    
    const [moment] = await db.insert(momentSubmissions).values({
      farmId: farm.id,
      status: 'pending',
      submitterName: parsedBody.name || null,
      submitterEmail: parsedBody.email || null,
      consent: parsedBody.consent,
      consentVersion: parsedBody.consentVersion,
      consentAt: new Date(),
      description: parsedBody.description,
      mediaKind: stored.mediaKind,
      mimeType: stored.mimeType,
      originalFilename,
      storageKey: stored.storageKey,
      byteSize: stored.byteSize,
      durationSeconds: stored.durationSeconds,
      retentionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }).returning()

    void notifyMomentSubmission(moment).catch((error) => {
      console.warn('Moment notification failed:', safeError(error))
    })

    return c.json(PUBLIC_ACCEPTED, 202)
  } catch (error) {
    if (stored) {
      await deleteMomentMedia(farm.id, stored.storageKey).catch(() => undefined)
    }
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
      description: m.description,
      groupLabel: m.groupLabel,
      consentVersion: m.consentVersion,
      consentAt: m.consentAt?.toISOString() ?? null,
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
      groupLabel: body.groupLabel === undefined ? existing.groupLabel : body.groupLabel,
      reviewedById: user.id,
      reviewedAt: new Date(),
      retentionExpiresAt:
        body.status === 'approved' ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
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
      groupLabel: { from: existing.groupLabel, to: body.groupLabel ?? existing.groupLabel },
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

  try {
    return await momentMediaResponse({
      farmId: user.farmId,
      storageKey: moment.storageKey,
      mimeType: moment.mimeType,
      rangeHeader: c.req.header('range'),
      cacheControl: 'private, max-age=3600',
    })
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})
