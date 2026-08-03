import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { journalPosts } from '../db/schema.js'
import { logAudit } from '../lib/audit.js'
import { resolveCustomerFarm } from '../lib/customer-orders.js'
import { triggerJournalBuildHook } from '../lib/journal-build-hook.js'
import { readJournalMedia, storeJournalMedia } from '../lib/journal-media.js'
import { checkRateLimit } from '../lib/rate-limit.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'

// A marketing rebuild reads the list, each post body, and each cover image in
// one burst. Keep that legitimate static-export flow below the per-IP ceiling.
const PUBLIC_RATE = { max: 300, windowMs: 60_000 }

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
  dataUrl: z.string().max(2_100_000),
})

function isOwner(user: { role: string }): boolean {
  return user.role === 'owner'
}

function validCoverUrl(farmId: string, value: string | null | undefined): boolean {
  if (value == null) return true
  const prefix = `/public/journal/media/${farmId}/`
  const filename = value.startsWith(prefix) ? value.slice(prefix.length) : ''
  return /^[A-Za-z0-9_-]{20,64}\.(?:jpg|png|webp)$/.test(filename)
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
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
  if (!isOwner(user)) return c.json({ error: 'Forbidden' }, 403)
  const posts = await db
    .select()
    .from(journalPosts)
    .where(eq(journalPosts.farmId, user.farmId))
    .orderBy(desc(journalPosts.createdAt))
  return c.json({ posts })
})

journalRoutes.get('/:id', async (c) => {
  const user = c.get('user')
  if (!isOwner(user)) return c.json({ error: 'Forbidden' }, 403)
  const [post] = await db
    .select()
    .from(journalPosts)
    .where(and(eq(journalPosts.id, c.req.param('id')), eq(journalPosts.farmId, user.farmId)))
    .limit(1)
  if (!post) return c.json({ error: 'Not found' }, 404)
  return c.json({ post })
})

journalRoutes.post('/media', zValidator('json', mediaSchema), async (c) => {
  const user = c.get('user')
  if (!isOwner(user)) return c.json({ error: 'Forbidden' }, 403)
  try {
    const url = await storeJournalMedia(user.farmId, c.req.valid('json').dataUrl)
    return c.json({ url }, 201)
  } catch {
    return c.json({ error: 'Invalid or unsupported image' }, 400)
  }
})

journalRoutes.post('/', zValidator('json', postFieldsSchema), async (c) => {
  const user = c.get('user')
  if (!isOwner(user)) return c.json({ error: 'Forbidden' }, 403)
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
      metadata: { slug: post.slug, published: false },
    })
    return c.json({ post }, 201)
  } catch (error) {
    if (isUniqueViolation(error)) return c.json({ error: 'Slug already exists' }, 409)
    throw error
  }
})

journalRoutes.patch('/:id', zValidator('json', patchPostSchema), async (c) => {
  const user = c.get('user')
  if (!isOwner(user)) return c.json({ error: 'Forbidden' }, 403)
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
  const publishedAt = nextPublished
    ? existing.publishedAt ?? new Date()
    : null

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
      metadata: { fields: Object.keys(body).sort() },
    })
    if (changedPublication) {
      await logAudit({
        farmId: user.farmId,
        userId: user.id,
        action: nextPublished ? 'publish' : 'unpublish',
        entityType: 'journal_post',
        entityId: postId,
      })
    }
    if (nextPublished || existing.published) triggerJournalBuildHook(postId)
    return c.json({ post })
  } catch (error) {
    if (isUniqueViolation(error)) return c.json({ error: 'Slug already exists' }, 409)
    throw error
  }
})

journalRoutes.delete('/:id', async (c) => {
  const user = c.get('user')
  if (!isOwner(user)) return c.json({ error: 'Forbidden' }, 403)
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
    metadata: { slug: existing.slug },
  })
  if (existing.published) triggerJournalBuildHook(postId)
  return c.json({ ok: true })
})

function publicRateLimit(c: {
  req: { header: (name: string) => string | undefined }
  header: (name: string, value: string) => void
}) {
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const result = checkRateLimit(`public-journal:${ip}`, PUBLIC_RATE.max, PUBLIC_RATE.windowMs)
  if (!result.allowed) c.header('Retry-After', String(result.retryAfterSec))
  return result.allowed
}

publicJournalRoutes.get('/', async (c) => {
  if (!publicRateLimit(c)) return c.json({ error: 'Too many requests - try again shortly.' }, 429)
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
  if (!publicRateLimit(c)) return c.json({ error: 'Too many requests - try again shortly.' }, 429)
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

publicJournalRoutes.get('/:slug', async (c) => {
  if (!publicRateLimit(c)) return c.json({ error: 'Too many requests - try again shortly.' }, 429)
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
