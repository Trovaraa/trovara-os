import { createHash, randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { zValidator } from '@hono/zod-validator'
import { and, count, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { journalComments, journalPostLikes, journalPosts } from '../db/schema.js'
import { logAudit } from '../lib/audit.js'
import { resolveCustomerFarm } from '../lib/customer-orders.js'
import { triggerJournalBuildHook } from '../lib/journal-build-hook.js'
import { readJournalMedia, storeJournalMedia } from '../lib/journal-media.js'
import { checkDurableRateLimit } from '../lib/rate-limit.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import { requestAccessMeta } from '../lib/request-access-meta.js'
import { hasPermission } from '../lib/rbac.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'

// A marketing rebuild reads the list, each post body, and each cover image in
// one burst. Keep that legitimate static-export flow below the per-IP ceiling.
const PUBLIC_RATE = { max: 300, windowMs: 60_000 }
const JOURNAL_VISITOR_COOKIE = 'trovara_journal_visitor'
const JOURNAL_VISITOR_PATTERN = /^[A-Za-z0-9_-]{32,64}$/

export function normalizeJournalSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .transform(normalizeJournalSlug)
  .pipe(
    z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid slug'),
  )

const tagsSchema = z
  .array(z.string().trim().min(1).max(50))
  .max(20)
  .transform((tags) => [...new Set(tags)])

const coverImageSchema = z.string().max(500).nullable()

const postFieldsSchema = z.object({
  slug: slugSchema,
  title: z.string().trim().min(1).max(200),
  excerpt: z.string().trim().min(1).max(600),
  bodyMarkdown: z.string().min(1).max(200_000),
  authorName: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(80),
  tags: tagsSchema.default([]),
  coverImageUrl: coverImageSchema.optional(),
})

const patchPostSchema = postFieldsSchema
  .partial()
  .extend({ published: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required')

const mediaSchema = z.object({
  dataUrl: z.string().max(3_400_000),
})

const commentSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    body: z.string().trim().min(2).max(1200),
    honey: z.string().max(500).optional(),
  })
  .strict()

const commentReviewSchema = z
  .object({ status: z.enum(['approved', 'rejected']) })
  .strict()

function validCoverUrl(farmId: string, value: string | null | undefined): boolean {
  if (value == null) return true
  const prefix = `/public/journal/media/${farmId}/`
  const filename = value.startsWith(prefix) ? value.slice(prefix.length) : ''
  return /^[A-Za-z0-9_-]{20,64}\.(?:jpg|png|webp)$/.test(filename)
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}

function visitorIdentity(c: Context): { token: string; hash: string } {
  const existing = getCookie(c, JOURNAL_VISITOR_COOKIE)
  const token = existing && JOURNAL_VISITOR_PATTERN.test(existing) ? existing : randomBytes(32).toString('base64url')
  if (token !== existing) {
    setCookie(c, JOURNAL_VISITOR_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      path: '/',
      maxAge: 365 * 24 * 60 * 60,
    })
  }
  return { token, hash: createHash('sha256').update(token).digest('hex') }
}

async function publishedPostForSlug(farmId: string, rawSlug: string) {
  const slug = normalizeJournalSlug(rawSlug)
  if (!slug) return null
  const [post] = await db
    .select({ id: journalPosts.id, slug: journalPosts.slug })
    .from(journalPosts)
    .where(
      and(
        eq(journalPosts.farmId, farmId),
        eq(journalPosts.slug, slug),
        eq(journalPosts.published, true),
      ),
    )
    .limit(1)
  return post ?? null
}

async function slugExists(farmId: string, slug: string, exceptId?: string): Promise<boolean> {
  const [row] = await db
    .select({ id: journalPosts.id })
    .from(journalPosts)
    .where(and(eq(journalPosts.farmId, farmId), eq(journalPosts.slug, slug)))
    .limit(1)
  return Boolean(row && row.id !== exceptId)
}

export const journalRoutes = new Hono<{ Variables: AppVariables }>()
export const publicJournalRoutes = new Hono()

journalRoutes.use('*', authMiddleware)

journalRoutes.get('/', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'journal.manage')) return c.json({ error: 'Forbidden' }, 403)
  const posts = await db
    .select()
    .from(journalPosts)
    .where(eq(journalPosts.farmId, user.farmId))
    .orderBy(desc(journalPosts.createdAt))
  return c.json({ posts })
})

/** Owner preview of covers (auth + /api proxy). Public marketing still uses /public/journal/media. */
journalRoutes.get('/media/:filename', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'journal.manage')) return c.json({ error: 'Forbidden' }, 403)
  const filename = c.req.param('filename')
  try {
    const { buffer, contentType } = await readJournalMedia(user.farmId, filename)
    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      },
    })
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})

journalRoutes.get('/:id', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'journal.manage')) return c.json({ error: 'Forbidden' }, 403)
  const [post] = await db
    .select()
    .from(journalPosts)
    .where(and(eq(journalPosts.id, c.req.param('id')), eq(journalPosts.farmId, user.farmId)))
    .limit(1)
  if (!post) return c.json({ error: 'Not found' }, 404)
  return c.json({ post })
})

journalRoutes.get('/:id/engagement', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'journal.manage')) return c.json({ error: 'Forbidden' }, 403)
  const postId = c.req.param('id')
  const [post] = await db
    .select({ id: journalPosts.id })
    .from(journalPosts)
    .where(and(eq(journalPosts.id, postId), eq(journalPosts.farmId, user.farmId)))
    .limit(1)
  if (!post) return c.json({ error: 'Not found' }, 404)

  const [likes, comments] = await Promise.all([
    db
      .select({ count: count() })
      .from(journalPostLikes)
      .where(and(eq(journalPostLikes.farmId, user.farmId), eq(journalPostLikes.postId, postId))),
    db
      .select({
        id: journalComments.id,
        authorName: journalComments.authorName,
        body: journalComments.body,
        status: journalComments.status,
        createdAt: journalComments.createdAt,
        moderatedAt: journalComments.moderatedAt,
      })
      .from(journalComments)
      .where(and(eq(journalComments.farmId, user.farmId), eq(journalComments.postId, postId)))
      .orderBy(desc(journalComments.createdAt))
      .limit(200),
  ])

  return c.json({ likeCount: Number(likes[0]?.count ?? 0), comments })
})

journalRoutes.patch(
  '/comments/:commentId',
  requireJournalManage,
  zValidator('json', commentReviewSchema),
  async (c) => {
    const user = c.get('user')
    const commentId = c.req.param('commentId')
    const status = c.req.valid('json').status
    const [existing] = await db
      .select({ id: journalComments.id, postId: journalComments.postId })
      .from(journalComments)
      .where(and(eq(journalComments.id, commentId), eq(journalComments.farmId, user.farmId)))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const [comment] = await db
      .update(journalComments)
      .set({
        status,
        moderatedById: user.id,
        moderatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(journalComments.id, commentId), eq(journalComments.farmId, user.farmId)))
      .returning()
    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: status === 'approved' ? 'approve' : 'reject',
      entityType: 'journal_comment',
      entityId: commentId,
      access: requestAccessMeta((name) => c.req.header(name)),
      metadata: { postId: existing.postId },
    })
    return c.json({ comment })
  },
)

async function requireJournalManage(c: Context<{ Variables: AppVariables }>, next: Next) {
  // Permission before Zod so unauthorized callers get 403, not a schema 400.
  if (!hasPermission(c.get('user'), 'journal.manage')) return c.json({ error: 'Forbidden' }, 403)
  await next()
}

journalRoutes.post(
  '/media',
  requireJournalManage,
  zValidator('json', mediaSchema),
  async (c) => {
    const user = c.get('user')
    try {
      const url = await storeJournalMedia(user.farmId, c.req.valid('json').dataUrl)
      return c.json({ url }, 201)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message.includes('too large')) {
        return c.json(
          {
            error:
              'Image too large. Use JPEG, PNG, or WebP under about 1.5 MB (covers are auto-resized to 1600px on upload).',
          },
          400,
        )
      }
      if (message.includes('MIME') || message.includes('data URL') || message.includes('Invalid')) {
        return c.json(
          {
            error:
              'Unsupported image. Use JPEG, PNG, or WebP under about 1.5 MB. On iPhone, set Camera → Formats → Most Compatible if HEIC fails.',
          },
          400,
        )
      }
      return c.json(
        {
          error:
            'Could not store that image. Use JPEG, PNG, or WebP under about 1.5 MB (max edge 1600px after resize).',
        },
        400,
      )
    }
  },
)

journalRoutes.post(
  '/',
  requireJournalManage,
  zValidator('json', postFieldsSchema),
  async (c) => {
    const user = c.get('user')
    const body = c.req.valid('json')
    if (!validCoverUrl(user.farmId, body.coverImageUrl)) {
      return c.json({ error: 'Invalid cover image URL' }, 400)
    }
    if (await slugExists(user.farmId, body.slug)) {
      return c.json({ error: 'Slug already exists' }, 409)
    }

    try {
      const [post] = await db
        .insert(journalPosts)
        .values({
          ...body,
          coverImageUrl: body.coverImageUrl ?? null,
          farmId: user.farmId,
          published: false,
          publishedAt: null,
          createdById: user.id,
          updatedById: user.id,
        })
        .returning()
      await logAudit({
        farmId: user.farmId,
        userId: user.id,
        action: 'create',
        entityType: 'journal_post',
        entityId: post.id,
        access: requestAccessMeta((name) => c.req.header(name)),
        metadata: { slug: post.slug, published: false },
      })
      return c.json({ post }, 201)
    } catch (error) {
      if (isUniqueViolation(error)) return c.json({ error: 'Slug already exists' }, 409)
      throw error
    }
  },
)

journalRoutes.patch(
  '/:id',
  requireJournalManage,
  zValidator('json', patchPostSchema),
  async (c) => {
    const user = c.get('user')
    const postId = c.req.param('id')
    const [existing] = await db
      .select()
      .from(journalPosts)
      .where(and(eq(journalPosts.id, postId), eq(journalPosts.farmId, user.farmId)))
      .limit(1)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const body = c.req.valid('json')
    if (!validCoverUrl(user.farmId, body.coverImageUrl)) {
      return c.json({ error: 'Invalid cover image URL' }, 400)
    }
    if (body.slug && (await slugExists(user.farmId, body.slug, postId))) {
      return c.json({ error: 'Slug already exists' }, 409)
    }

    const nextPublished = body.published ?? existing.published
    const changedPublication = nextPublished !== existing.published
    const publishedAt = nextPublished ? existing.publishedAt ?? new Date() : null

    try {
      const [post] = await db
        .update(journalPosts)
        .set({
          ...body,
          published: nextPublished,
          publishedAt,
          updatedById: user.id,
          updatedAt: new Date(),
        })
        .where(and(eq(journalPosts.id, postId), eq(journalPosts.farmId, user.farmId)))
        .returning()

      await logAudit({
        farmId: user.farmId,
        userId: user.id,
        action: 'update',
        entityType: 'journal_post',
        entityId: postId,
        access: requestAccessMeta((name) => c.req.header(name)),
        metadata: { fields: Object.keys(body).sort() },
      })
      if (changedPublication) {
        await logAudit({
          farmId: user.farmId,
          userId: user.id,
          action: nextPublished ? 'publish' : 'unpublish',
          entityType: 'journal_post',
          entityId: postId,
          access: requestAccessMeta((name) => c.req.header(name)),
        })
      }
      if (nextPublished || existing.published) triggerJournalBuildHook(postId)
      return c.json({ post })
    } catch (error) {
      if (isUniqueViolation(error)) return c.json({ error: 'Slug already exists' }, 409)
      throw error
    }
  },
)

journalRoutes.delete('/:id', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'journal.manage')) return c.json({ error: 'Forbidden' }, 403)
  const postId = c.req.param('id')
  const [existing] = await db
    .select({
      id: journalPosts.id,
      slug: journalPosts.slug,
      published: journalPosts.published,
    })
    .from(journalPosts)
    .where(and(eq(journalPosts.id, postId), eq(journalPosts.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db
    .delete(journalPosts)
    .where(and(eq(journalPosts.id, postId), eq(journalPosts.farmId, user.farmId)))
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'journal_post',
    entityId: postId,
    access: requestAccessMeta((name) => c.req.header(name)),
    metadata: { slug: existing.slug },
  })
  if (existing.published) triggerJournalBuildHook(postId)
  return c.json({ ok: true })
})

async function publicRateLimit(c: {
  req: { header: (name: string) => string | undefined }
  header: (name: string, value: string) => void
}) {
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const result = await checkDurableRateLimit(`public-journal:${ip}`, PUBLIC_RATE.max, PUBLIC_RATE.windowMs)
  if (!result.allowed) c.header('Retry-After', String(result.retryAfterSec))
  return result.allowed
}

async function publicActionRateLimit(
  c: {
    req: { header: (name: string) => string | undefined }
    header: (name: string, value: string) => void
  },
  action: string,
  max: number,
  windowMs: number,
) {
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const result = await checkDurableRateLimit(`public-journal:${action}:${ip}`, max, windowMs)
  if (!result.allowed) c.header('Retry-After', String(result.retryAfterSec))
  return result.allowed
}

publicJournalRoutes.get('/', async (c) => {
  if (!(await publicRateLimit(c))) return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Journal is not available yet.' }, 503)
  const posts = await db
    .select({
      slug: journalPosts.slug,
      title: journalPosts.title,
      excerpt: journalPosts.excerpt,
      authorName: journalPosts.authorName,
      category: journalPosts.category,
      tags: journalPosts.tags,
      coverImageUrl: journalPosts.coverImageUrl,
      published: journalPosts.published,
      publishedAt: journalPosts.publishedAt,
    })
    .from(journalPosts)
    .where(and(eq(journalPosts.farmId, farm.id), eq(journalPosts.published, true)))
    .orderBy(desc(journalPosts.publishedAt))
    .limit(100)
  return c.json({ posts: posts.filter((post) => post.published) })
})

publicJournalRoutes.get('/media/:farmId/:filename', async (c) => {
  if (!(await publicRateLimit(c))) return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Not found' }, 404)
  const farmId = c.req.param('farmId')
  if (farmId !== farm.id) return c.json({ error: 'Not found' }, 404)
  const filename = c.req.param('filename')

  try {
    const { buffer, contentType } = await readJournalMedia(farmId, filename)
    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      },
    })
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})

publicJournalRoutes.get('/:slug/engagement', async (c) => {
  if (!(await publicActionRateLimit(c, 'engagement', 120, 60_000))) {
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Journal is not available yet.' }, 503)
  const post = await publishedPostForSlug(farm.id, c.req.param('slug'))
  if (!post) return c.json({ error: 'Not found' }, 404)
  const { hash } = visitorIdentity(c)

  const [likes, viewerLike, comments] = await Promise.all([
    db
      .select({ count: count() })
      .from(journalPostLikes)
      .where(and(eq(journalPostLikes.farmId, farm.id), eq(journalPostLikes.postId, post.id))),
    db
      .select({ id: journalPostLikes.id })
      .from(journalPostLikes)
      .where(and(eq(journalPostLikes.postId, post.id), eq(journalPostLikes.visitorHash, hash)))
      .limit(1),
    db
      .select({
        id: journalComments.id,
        authorName: journalComments.authorName,
        body: journalComments.body,
        createdAt: journalComments.createdAt,
      })
      .from(journalComments)
      .where(
        and(
          eq(journalComments.farmId, farm.id),
          eq(journalComments.postId, post.id),
          eq(journalComments.status, 'approved'),
        ),
      )
      .orderBy(desc(journalComments.createdAt))
      .limit(100),
  ])

  return c.json({
    likeCount: Number(likes[0]?.count ?? 0),
    liked: Boolean(viewerLike[0]),
    comments,
  })
})

publicJournalRoutes.post('/:slug/like', async (c) => {
  if (!(await publicActionRateLimit(c, 'like', 30, 60_000))) {
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Journal is not available yet.' }, 503)
  const post = await publishedPostForSlug(farm.id, c.req.param('slug'))
  if (!post) return c.json({ error: 'Not found' }, 404)
  const { hash } = visitorIdentity(c)
  const [existing] = await db
    .select({ id: journalPostLikes.id })
    .from(journalPostLikes)
    .where(and(eq(journalPostLikes.postId, post.id), eq(journalPostLikes.visitorHash, hash)))
    .limit(1)

  if (existing) {
    await db
      .delete(journalPostLikes)
      .where(and(eq(journalPostLikes.id, existing.id), eq(journalPostLikes.farmId, farm.id)))
  } else {
    await db
      .insert(journalPostLikes)
      .values({ farmId: farm.id, postId: post.id, visitorHash: hash })
      .onConflictDoNothing()
  }

  const [likes] = await db
    .select({ count: count() })
    .from(journalPostLikes)
    .where(and(eq(journalPostLikes.farmId, farm.id), eq(journalPostLikes.postId, post.id)))
  return c.json({ liked: !existing, likeCount: Number(likes?.count ?? 0) })
})

publicJournalRoutes.post(
  '/:slug/comments',
  zValidator('json', commentSchema),
  async (c) => {
    if (!(await publicActionRateLimit(c, 'comment', 3, 10 * 60_000))) {
      return c.json({ error: 'Too many comments - please wait before trying again.' }, 429)
    }
    const body = c.req.valid('json')
    // Honeypots receive the same accepted response, without writing spam.
    if (body.honey?.trim()) return c.json({ ok: true, status: 'pending' }, 202)
    const farm = await resolveCustomerFarm()
    if (!farm) return c.json({ error: 'Journal is not available yet.' }, 503)
    const post = await publishedPostForSlug(farm.id, c.req.param('slug'))
    if (!post) return c.json({ error: 'Not found' }, 404)
    const { hash } = visitorIdentity(c)
    await db.insert(journalComments).values({
      farmId: farm.id,
      postId: post.id,
      visitorHash: hash,
      authorName: body.name,
      body: body.body,
      status: 'pending',
    })
    return c.json({ ok: true, status: 'pending' }, 202)
  },
)

publicJournalRoutes.get('/:slug', async (c) => {
  if (!(await publicRateLimit(c))) return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Journal is not available yet.' }, 503)
  const slug = normalizeJournalSlug(c.req.param('slug'))
  if (!slug) return c.json({ error: 'Not found' }, 404)
  const [post] = await db
    .select({
      slug: journalPosts.slug,
      title: journalPosts.title,
      excerpt: journalPosts.excerpt,
      bodyMarkdown: journalPosts.bodyMarkdown,
      authorName: journalPosts.authorName,
      category: journalPosts.category,
      tags: journalPosts.tags,
      coverImageUrl: journalPosts.coverImageUrl,
      publishedAt: journalPosts.publishedAt,
    })
    .from(journalPosts)
    .where(
      and(
        eq(journalPosts.farmId, farm.id),
        eq(journalPosts.slug, slug),
        eq(journalPosts.published, true),
      ),
    )
    .limit(1)
  if (!post) return c.json({ error: 'Not found' }, 404)
  return c.json({ post })
})
