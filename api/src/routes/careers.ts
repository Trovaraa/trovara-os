import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { careerPosts } from '../db/schema.js'
import { logAudit } from '../lib/audit.js'
import { resolveCustomerFarm } from '../lib/customer-orders.js'
import { checkDurableRateLimit } from '../lib/rate-limit.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import { hasPermission } from '../lib/rbac.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'

const PUBLIC_RATE = { max: 120, windowMs: 60_000 }

const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'internship',
  'temporary',
] as const

export function normalizeCareerSlug(value: string): string {
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
  .transform(normalizeCareerSlug)
  .pipe(
    z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Invalid slug'),
  )

const postFieldsSchema = z.object({
  slug: slugSchema,
  title: z.string().trim().min(1).max(200),
  department: z.string().trim().max(120).nullable().optional(),
  location: z.string().trim().max(120).nullable().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('full_time'),
  summary: z.string().trim().min(1).max(600),
  bodyMarkdown: z.string().trim().min(1).max(50_000),
  applyEmail: z.string().trim().email().max(320).default('hello@trovara.farm'),
})

const patchPostSchema = postFieldsSchema
  .partial()
  .extend({ published: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required')

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}

async function slugExists(farmId: string, slug: string, exceptId?: string): Promise<boolean> {
  const [row] = await db
    .select({ id: careerPosts.id })
    .from(careerPosts)
    .where(and(eq(careerPosts.farmId, farmId), eq(careerPosts.slug, slug)))
    .limit(1)
  return Boolean(row && row.id !== exceptId)
}

async function publicRateLimit(c: {
  req: { header: (name: string) => string | undefined }
  header: (name: string, value: string) => void
}): Promise<boolean> {
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const result = await checkDurableRateLimit(`careers:${ip}`, PUBLIC_RATE.max, PUBLIC_RATE.windowMs)
  if (!result.allowed) c.header('Retry-After', String(result.retryAfterSec))
  return result.allowed
}

function publicPost(row: typeof careerPosts.$inferSelect) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    department: row.department,
    location: row.location,
    employmentType: row.employmentType,
    summary: row.summary,
    bodyMarkdown: row.bodyMarkdown,
    applyEmail: row.applyEmail,
    publishedAt: row.publishedAt,
  }
}

export const careersRoutes = new Hono<{ Variables: AppVariables }>()
export const publicCareersRoutes = new Hono()

careersRoutes.use('*', authMiddleware)

async function requireCareersManage(c: Context<{ Variables: AppVariables }>, next: Next) {
  if (!hasPermission(c.get('user'), 'careers.manage')) return c.json({ error: 'Forbidden' }, 403)
  await next()
}

careersRoutes.get('/', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'careers.manage')) return c.json({ error: 'Forbidden' }, 403)
  const posts = await db
    .select()
    .from(careerPosts)
    .where(eq(careerPosts.farmId, user.farmId))
    .orderBy(desc(careerPosts.createdAt))
  return c.json({ posts })
})

careersRoutes.get('/:id', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'careers.manage')) return c.json({ error: 'Forbidden' }, 403)
  const [post] = await db
    .select()
    .from(careerPosts)
    .where(and(eq(careerPosts.id, c.req.param('id')), eq(careerPosts.farmId, user.farmId)))
    .limit(1)
  if (!post) return c.json({ error: 'Not found' }, 404)
  return c.json({ post })
})

careersRoutes.post('/', requireCareersManage, zValidator('json', postFieldsSchema), async (c) => {
  const user = c.get('user')
  const body = c.req.valid('json')
  if (await slugExists(user.farmId, body.slug)) {
    return c.json({ error: 'Slug already exists' }, 409)
  }

  try {
    const [post] = await db
      .insert(careerPosts)
      .values({
        farmId: user.farmId,
        slug: body.slug,
        title: body.title,
        department: body.department ?? null,
        location: body.location ?? null,
        employmentType: body.employmentType,
        summary: body.summary,
        bodyMarkdown: body.bodyMarkdown,
        applyEmail: body.applyEmail,
        createdById: user.id,
        updatedById: user.id,
      })
      .returning()

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'create',
      entityType: 'career_post',
      entityId: post.id,
      metadata: { slug: post.slug },
    })
    return c.json({ post }, 201)
  } catch (error) {
    if (isUniqueViolation(error)) return c.json({ error: 'Slug already exists' }, 409)
    throw error
  }
})

careersRoutes.patch('/:id', requireCareersManage, zValidator('json', patchPostSchema), async (c) => {
  const user = c.get('user')
  const postId = c.req.param('id')
  if (!postId) return c.json({ error: 'Not found' }, 404)
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(careerPosts)
    .where(and(eq(careerPosts.id, postId), eq(careerPosts.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  if (body.slug && (await slugExists(user.farmId, body.slug, postId))) {
    return c.json({ error: 'Slug already exists' }, 409)
  }

  const updates: Partial<typeof careerPosts.$inferInsert> = {
    updatedById: user.id,
    updatedAt: new Date(),
  }
  if (body.slug !== undefined) updates.slug = body.slug
  if (body.title !== undefined) updates.title = body.title
  if (body.department !== undefined) updates.department = body.department
  if (body.location !== undefined) updates.location = body.location
  if (body.employmentType !== undefined) updates.employmentType = body.employmentType
  if (body.summary !== undefined) updates.summary = body.summary
  if (body.bodyMarkdown !== undefined) updates.bodyMarkdown = body.bodyMarkdown
  if (body.applyEmail !== undefined) updates.applyEmail = body.applyEmail
  if (body.published !== undefined) {
    updates.published = body.published
    updates.publishedAt = body.published
      ? existing.publishedAt ?? new Date()
      : null
  }

  try {
    const [post] = await db
      .update(careerPosts)
      .set(updates)
      .where(eq(careerPosts.id, postId))
      .returning()

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'update',
      entityType: 'career_post',
      entityId: post.id,
      metadata: { slug: post.slug, published: post.published },
    })
    return c.json({ post })
  } catch (error) {
    if (isUniqueViolation(error)) return c.json({ error: 'Slug already exists' }, 409)
    throw error
  }
})

careersRoutes.delete('/:id', requireCareersManage, async (c) => {
  const user = c.get('user')
  const postId = c.req.param('id')
  if (!postId) return c.json({ error: 'Not found' }, 404)
  const [existing] = await db
    .select()
    .from(careerPosts)
    .where(and(eq(careerPosts.id, postId), eq(careerPosts.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(careerPosts).where(eq(careerPosts.id, postId))
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'career_post',
    entityId: postId,
    metadata: { slug: existing.slug },
  })
  return c.json({ ok: true })
})

publicCareersRoutes.get('/', async (c) => {
  if (!(await publicRateLimit(c))) return c.json({ error: 'Too many requests' }, 429)
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ posts: [] })

  const posts = await db
    .select()
    .from(careerPosts)
    .where(
      and(
        eq(careerPosts.farmId, farm.id),
        eq(careerPosts.published, true),
        isNotNull(careerPosts.publishedAt),
      ),
    )
    .orderBy(desc(careerPosts.publishedAt))

  return c.json({ posts: posts.map(publicPost) })
})

publicCareersRoutes.get('/:slug', async (c) => {
  if (!(await publicRateLimit(c))) return c.json({ error: 'Too many requests' }, 429)
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'Not found' }, 404)

  const slug = normalizeCareerSlug(c.req.param('slug'))
  const [post] = await db
    .select()
    .from(careerPosts)
    .where(
      and(
        eq(careerPosts.farmId, farm.id),
        eq(careerPosts.slug, slug),
        eq(careerPosts.published, true),
        isNotNull(careerPosts.publishedAt),
      ),
    )
    .limit(1)
  if (!post) return c.json({ error: 'Not found' }, 404)
  return c.json({ post: publicPost(post) })
})
