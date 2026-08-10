import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  pgEnum,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core'

export const userRoleEnum = pgEnum('user_role', ['owner', 'supervisor', 'field_worker', 'sales'])
export const butlerTtsModeEnum = pgEnum('butler_tts_mode', ['off', 'voice_replies', 'always'])
export const taskStatusEnum = pgEnum('task_status', [
  'pending',
  'in_progress',
  'awaiting_approval',
  'completed',
  'rejected',
])
export const inventoryUnitEnum = pgEnum('inventory_unit', ['kg', 'bags', 'liters', 'units', 'crates'])
export const cropStageEnum = pgEnum('crop_stage', [
  'planted',
  'germination',
  'vegetative',
  'flowering',
  'fruiting',
  'harvest_ready',
  'harvested',
])
export const livestockLogTypeEnum = pgEnum('livestock_log_type', [
  'feeding',
  'vaccination',
  'mortality',
  'incident',
  'health_check',
])
export const orderStatusEnum = pgEnum('order_status', [
  'pending',
  'confirmed',
  'dispatched',
  'delivered',
  'cancelled',
])
export const paymentStatusEnum = pgEnum('payment_status', [
  'unpaid',
  'paid',
  'not_required',
  'refunded',
  'partially_refunded',
  'refund_pending',
])
export const expenseCategoryEnum = pgEnum('expense_category', [
  'inputs',
  'labour',
  'equipment',
  'transport',
  'utilities',
  'feed',
  'medicine',
  'other',
])
export const recurrenceEnum = pgEnum('recurrence', ['daily', 'weekly', 'monthly', 'crop_stage'])
export const farmEventTypeEnum = pgEnum('farm_event_type', [
  'planted',
  'watered',
  'weeded',
  'fertilized',
  'harvested',
  'fed',
  'vaccinated',
  'mortality',
  'sold',
  'moved',
  'incident',
  'other',
])
export const poultryBatchTypeEnum = pgEnum('poultry_batch_type', ['noiler', 'layer', 'pullet', 'other'])
export const purchaseOrderStatusEnum = pgEnum('purchase_order_status', [
  'draft',
  'approved',
  'sent',
  'partially_received',
  'received',
  'cancelled',
])
export const newsletterSubscriberStatusEnum = pgEnum('newsletter_subscriber_status', [
  'pending',
  'confirmed',
  'unsubscribed',
  'suppressed',
])
export const newsletterSyncStatusEnum = pgEnum('newsletter_sync_status', [
  'pending',
  'synced',
  'failed',
])
export const newsletterDeliveryStatusEnum = pgEnum('newsletter_delivery_status', [
  'pending',
  'sent',
  'failed',
])
export const marketingLeadTypeEnum = pgEnum('marketing_lead_type', [
  'contact',
  'product_waitlist',
])
export const marketingLeadStatusEnum = pgEnum('marketing_lead_status', [
  'new',
  'in_progress',
  'contacted',
  'closed',
  'spam',
])
export const marketingLeadNotificationStatusEnum = pgEnum('marketing_lead_notification_status', [
  'pending',
  'sent',
  'failed',
])

/**
 * Free-text columns are stored in canonical English. `translation_status`
 * tracks rows whose write happened while the LLM was unavailable: they hold
 * the author's original text until the retry job replaces it with English.
 * `translation_attempts` counts retry-job LLM tries so give-up does not depend
 * on a fragile updatedAt / createdAt heuristic.
 */
export const translationStatusEnum = pgEnum('translation_status', ['done', 'pending', 'failed'])
/**
 * Who authored a piece of agronomy: a model working from the species the farmer
 * entered, or a person on the farm. Anything 'manual' is never regenerated over
 * — the farmer knows their birds better than the generator does.
 */
export const agronomySourceEnum = pgEnum('agronomy_source', ['generated', 'manual'])

export const farms = pgTable('farms', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  // Stable, human-readable identifier used to scope public traceability links
  // (e.g. /lot/:slug/:lotCode). Unique across farms.
  slug: text('slug').notNull().unique(),
  location: text('location').notNull(),
  latitude: text('latitude'),
  longitude: text('longitude'),
  timezone: text('timezone').default('Africa/Lagos'),
  liveMode: boolean('live_mode').default(false).notNull(),
  liveStartedAt: timestamp('live_started_at', { withTimezone: true }),
  /** Daily OS + marketing health/SLA Telegram report to owners and supervisors. */
  healthSlaAlertsEnabled: boolean('health_sla_alerts_enabled').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const weatherCache = pgTable('weather_cache', {
  farmId: uuid('farm_id')
    .primaryKey()
    .references(() => farms.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRoleEnum('role').notNull(),
    phone: text('phone'),
    monthlyWageNgn: integer('monthly_wage_ngn'),
    monthlyWageEffectiveFrom: text('monthly_wage_effective_from'),
    monthlyWageConfirmedAt: timestamp('monthly_wage_confirmed_at', { withTimezone: true }),
    monthlyWageConfirmedById: uuid('monthly_wage_confirmed_by_id'),
    nextOfKinName: text('next_of_kin_name'),
    nextOfKinPhone: text('next_of_kin_phone'),
    nextOfKinRelationship: text('next_of_kin_relationship'),
    employeeNumber: text('employee_number'),
    jobTitle: text('job_title'),
    employmentType: text('employment_type'),
    employmentStartDate: text('employment_start_date'),
    employmentEndDate: text('employment_end_date'),
    employmentStatus: text('employment_status').default('employed'),
    mustChangePassword: boolean('must_change_password').default(false).notNull(),
    totpSecret: text('totp_secret'),
    totpEnabled: boolean('totp_enabled').default(false).notNull(),
    totpRecoveryCodes: jsonb('totp_recovery_codes'),
    butlerTtsMode: butlerTtsModeEnum('butler_tts_mode').default('voice_replies').notNull(),
    /** Staff butler reply language: en | yo | pcm | fr */
    preferredLocale: text('preferred_locale').default('en').notNull(),
    /**
     * When the worker picked `preferred_locale` themselves. Null means they never
     * answered and the column is still holding its 'en' default.
     *
     * Note this does NOT make an 'en' preference trustworthy as a source-language
     * hint — see `authorLocaleHint`. It exists to find the workers who never
     * answered, because those are the ones whose writes fall back to guessing.
     */
    preferredLocaleSetAt: timestamp('preferred_locale_set_at', { withTimezone: true }),
    /** Last time Butler asked them to pick a language, to re-ask at most daily. */
    preferredLocalePromptedAt: timestamp('preferred_locale_prompted_at', {
      withTimezone: true,
    }),
    /**
     * Owner-only opt-in for customer order alerts (new order, feedback, etc.).
     * Supervisor and sales always receive those alerts; field workers never do.
     */
    orderAlertsSubscribed: boolean('order_alerts_subscribed').default(false).notNull(),
    /**
     * Owner-only opt-in for field-worker alerts (task submitted for approval, urgent TG/WA).
     * Supervisors always receive these; sales and field workers do not.
     */
    workerAlertsSubscribed: boolean('worker_alerts_subscribed').default(false).notNull(),
    active: boolean('active').default(true).notNull(),
    /** Farm-scoped role bundle; null falls back to system template for `role`. */
    farmRoleId: uuid('farm_role_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('users_farm_employee_number_uq').on(t.farmId, t.employeeNumber),
    index('users_farm_role_id_idx').on(t.farmRoleId),
  ],
)

export const farmRoles = pgTable(
  'farm_roles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').default(false).notNull(),
    clonedFrom: text('cloned_from'),
    permissionsVersion: integer('permissions_version').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('farm_roles_farm_name_uq').on(t.farmId, t.name),
    index('farm_roles_farm_cloned_from_idx').on(t.farmId, t.clonedFrom),
  ],
)

export const farmRolePermissions = pgTable(
  'farm_role_permissions',
  {
    roleId: uuid('role_id')
      .references(() => farmRoles.id, { onDelete: 'cascade' })
      .notNull(),
    permissionKey: text('permission_key').notNull(),
  },
  (t) => [uniqueIndex('farm_role_permissions_pk').on(t.roleId, t.permissionKey)],
)

export const portalVaultEntries = pgTable(
  'portal_vault_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    label: text('label').notNull(),
    category: text('category').default('other').notNull(),
    loginUrl: text('login_url').notNull(),
    loginEmail: text('login_email').notNull(),
    passwordCiphertext: text('password_ciphertext').notNull(),
    notes: text('notes'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('portal_vault_entries_farm_idx').on(t.farmId)],
)

export const brandAssets = pgTable(
  'brand_assets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    /** Final stored file once status is ready; null while processing. */
    filename: text('filename'),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size'),
    width: integer('width'),
    height: integer('height'),
    mediaKind: text('media_kind').default('image').notNull(),
    status: text('status').default('ready').notNull(),
    processingError: text('processing_error'),
    sourceMimeType: text('source_mime_type'),
    durationSeconds: integer('duration_seconds'),
    posterFilename: text('poster_filename'),
    pendingSourcePath: text('pending_source_path'),
    pendingOriginalName: text('pending_original_name'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('brand_assets_farm_idx').on(t.farmId),
    uniqueIndex('brand_assets_farm_filename_uq').on(t.farmId, t.filename),
    index('brand_assets_status_idx').on(t.farmId, t.status),
    check('brand_assets_media_kind_check', sql`${t.mediaKind} in ('image', 'video')`),
    check(
      'brand_assets_status_check',
      sql`${t.status} in ('uploading', 'processing', 'ready', 'failed')`,
    ),
    check(
      'brand_assets_duration_check',
      sql`${t.durationSeconds} is null or ${t.durationSeconds} >= 0`,
    ),
  ],
)

export const brandPacks = pgTable(
  'brand_packs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    title: text('title').notNull(),
    notes: text('notes'),
    shareToken: text('share_token').notNull(),
    passwordHash: text('password_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    viewCount: integer('view_count').default(0).notNull(),
    downloadCount: integer('download_count').default(0).notNull(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('brand_packs_share_token_uq').on(t.shareToken),
    index('brand_packs_farm_idx').on(t.farmId),
  ],
)

export const brandPackAssets = pgTable(
  'brand_pack_assets',
  {
    packId: uuid('pack_id')
      .references(() => brandPacks.id, { onDelete: 'cascade' })
      .notNull(),
    assetId: uuid('asset_id')
      .references(() => brandAssets.id, { onDelete: 'cascade' })
      .notNull(),
    position: integer('position').default(0).notNull(),
  },
  (t) => [
    uniqueIndex('brand_pack_assets_pk').on(t.packId, t.assetId),
    index('brand_pack_assets_asset_idx').on(t.assetId),
  ],
)

export const journalPosts = pgTable(
  'journal_posts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    excerpt: text('excerpt').notNull(),
    bodyMarkdown: text('body_markdown').notNull(),
    authorName: text('author_name').notNull(),
    category: text('category').notNull(),
    tags: jsonb('tags').$type<string[]>().default([]).notNull(),
    coverImageUrl: text('cover_image_url'),
    published: boolean('published').default(false).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdById: uuid('created_by_id')
      .references(() => users.id, { onDelete: 'restrict' })
      .notNull(),
    updatedById: uuid('updated_by_id')
      .references(() => users.id, { onDelete: 'restrict' })
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('journal_posts_farm_slug_uq').on(t.farmId, t.slug),
    index('journal_posts_farm_created_idx').on(t.farmId, t.createdAt),
    index('journal_posts_public_idx')
      .on(t.farmId, t.publishedAt)
      .where(sql`${t.published} = true`),
    check('journal_posts_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check(
      'journal_posts_published_at_consistent',
      sql`(${t.published} = false) or (${t.publishedAt} is not null)`,
    ),
    check('journal_posts_tags_array', sql`jsonb_typeof(${t.tags}) = 'array'`),
  ],
)

export const newsletterSubscribers = pgTable(
  'newsletter_subscribers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'restrict' }).notNull(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    emailConsentAt: timestamp('email_consent_at', { withTimezone: true }).notNull(),
    emailConsentVersion: text('email_consent_version').notNull(),
    emailConsentSource: text('email_consent_source').notNull(),
    phoneConsentAt: timestamp('phone_consent_at', { withTimezone: true }),
    status: newsletterSubscriberStatusEnum('status').default('pending').notNull(),
    confirmationTokenHash: text('confirmation_token_hash'),
    confirmationTokenExpiresAt: timestamp('confirmation_token_expires_at', { withTimezone: true }),
    confirmationDeliveryStatus: newsletterDeliveryStatusEnum('confirmation_delivery_status')
      .default('pending')
      .notNull(),
    confirmationDeliveryError: text('confirmation_delivery_error'),
    confirmationLastSentAt: timestamp('confirmation_last_sent_at', { withTimezone: true }),
    unsubscribeTokenHash: text('unsubscribe_token_hash').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    unsubscribedReason: text('unsubscribed_reason'),
    suppressedAt: timestamp('suppressed_at', { withTimezone: true }),
    suppressedReason: text('suppressed_reason'),
    resendContactId: text('resend_contact_id'),
    resendLastSyncStatus: newsletterSyncStatusEnum('resend_last_sync_status')
      .default('pending')
      .notNull(),
    resendLastSyncError: text('resend_last_sync_error'),
    resendLastSyncAt: timestamp('resend_last_sync_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('newsletter_subscribers_farm_email_uq').on(t.farmId, t.email),
    uniqueIndex('newsletter_subscribers_confirmation_token_uq')
      .on(t.confirmationTokenHash)
      .where(sql`${t.confirmationTokenHash} is not null`),
    uniqueIndex('newsletter_subscribers_unsubscribe_token_uq').on(t.unsubscribeTokenHash),
    index('newsletter_subscribers_farm_status_idx').on(t.farmId, t.status),
    check('newsletter_subscribers_email_normalized', sql`${t.email} = lower(${t.email})`),
    check(
      'newsletter_subscribers_confirmation_token_consistent',
      sql`(${t.confirmationTokenHash} is null) = (${t.confirmationTokenExpiresAt} is null)`,
    ),
    check(
      'newsletter_subscribers_phone_consent_consistent',
      sql`${t.phone} is null or ${t.phoneConsentAt} is not null`,
    ),
  ],
)

export const newsletterConsentEvents = pgTable(
  'newsletter_consent_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    subscriberId: uuid('subscriber_id')
      .references(() => newsletterSubscribers.id, { onDelete: 'restrict' })
      .notNull(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'restrict' }).notNull(),
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    emailConsentAt: timestamp('email_consent_at', { withTimezone: true }).notNull(),
    emailConsentVersion: text('email_consent_version').notNull(),
    emailConsentSource: text('email_consent_source').notNull(),
    phoneConsentAt: timestamp('phone_consent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('newsletter_consent_events_subscriber_created_idx').on(t.subscriberId, t.createdAt),
    index('newsletter_consent_events_farm_created_idx').on(t.farmId, t.createdAt),
  ],
)

export const newsletterWebhookEvents = pgTable(
  'newsletter_webhook_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'restrict' }).notNull(),
    svixId: text('svix_id').notNull(),
    eventType: text('event_type').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processingError: text('processing_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('newsletter_webhook_events_svix_id_uq').on(t.svixId),
    index('newsletter_webhook_events_farm_created_idx').on(t.farmId, t.createdAt),
  ],
)

export const marketingLeads = pgTable(
  'marketing_leads',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'restrict' }).notNull(),
    leadType: marketingLeadTypeEnum('lead_type').notNull(),
    status: marketingLeadStatusEnum('status').default('new').notNull(),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    normalizedContact: text('normalized_contact').notNull(),
    subjectKey: text('subject_key'),
    subjectLabel: text('subject_label'),
    message: text('message'),
    productKey: text('product_key'),
    productLabel: text('product_label'),
    source: text('source').notNull(),
    submissionCount: integer('submission_count').default(1).notNull(),
    lastSubmittedAt: timestamp('last_submitted_at', { withTimezone: true }).defaultNow().notNull(),
    assignedToId: uuid('assigned_to_id').references(() => users.id, { onDelete: 'set null' }),
    staffNotificationStatus: marketingLeadNotificationStatusEnum('staff_notification_status')
      .default('pending')
      .notNull(),
    staffNotificationError: text('staff_notification_error'),
    staffNotifiedAt: timestamp('staff_notified_at', { withTimezone: true }),
    // Nullable so pre-consent rows remain readable after migration backfill.
    consentAt: timestamp('consent_at', { withTimezone: true }),
    consentVersion: text('consent_version'),
    privacyNoticeUrl: text('privacy_notice_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('marketing_leads_farm_status_idx').on(t.farmId, t.status),
    index('marketing_leads_farm_type_idx').on(t.farmId, t.leadType),
    index('marketing_leads_farm_created_idx').on(t.farmId, t.createdAt),
    uniqueIndex('marketing_leads_waitlist_contact_uq')
      .on(t.farmId, t.productKey, t.normalizedContact)
      .where(sql`${t.leadType} = 'product_waitlist'`),
    check(
      'marketing_leads_contact_shape',
      sql`${t.leadType} <> 'contact' or (${t.email} is not null and ${t.subjectKey} is not null and ${t.subjectLabel} is not null and ${t.message} is not null)`,
    ),
    check(
      'marketing_leads_waitlist_shape',
      sql`${t.leadType} <> 'product_waitlist' or (${t.productKey} is not null and ${t.productLabel} is not null and (${t.email} is not null or ${t.phone} is not null))`,
    ),
    check('marketing_leads_submission_count_positive', sql`${t.submissionCount} >= 1`),
  ],
)

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  userAgent: text('user_agent'),
  ipHash: text('ip_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

/** Durable login attempt counters (survive API restarts; used for staff + shop). */
export const loginRateLimits = pgTable('login_rate_limits', {
  rateKey: text('rate_key').primaryKey(),
  attemptCount: integer('attempt_count').default(0).notNull(),
  windowStartsAt: timestamp('window_starts_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// Single-use owner-registration tokens. Replace the reusable
// OWNER_REGISTRATION_SECRET env value: each token is consumed on first
// successful /register and cannot be reused. Only the sha256 hash is stored.
export const registrationTokens = pgTable('registration_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  label: text('label'),
  // Null when minted by the bootstrap CLI (no owner exists yet).
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedByUserId: uuid('used_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const consentRecords = pgTable('consent_records', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
  consentType: text('consent_type').notNull(),
  version: text('version').notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).defaultNow().notNull(),
})

export const taskTemplates = pgTable(
  'task_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    cropType: text('crop_type'),
    checklist: jsonb('checklist').$type<string[]>(),
    defaultDurationHours: integer('default_duration_hours'),
    actionType: text('action_type'),
    systemTemplateKey: text('system_template_key'),
    defaultPayload: jsonb('default_payload').$type<Record<string, unknown>>(),
    sourceLocale: text('source_locale'),
    translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
    translationAttempts: integer('translation_attempts').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('task_templates_farm_system_key_uq').on(t.farmId, t.systemTemplateKey),
  ],
)

export const recurringSchedules = pgTable('recurring_schedules', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  templateId: uuid('template_id').references(() => taskTemplates.id).notNull(),
  recurrence: recurrenceEnum('recurrence').notNull(),
  assignedToId: uuid('assigned_to_id').references(() => users.id),
  plotId: uuid('plot_id').references(() => plots.id),
  active: boolean('active').default(true).notNull(),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const farmEvents = pgTable('farm_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  eventType: farmEventTypeEnum('event_type').notNull(),
  beforeValue: jsonb('before_value'),
  afterValue: jsonb('after_value'),
  source: text('source').default('web').notNull(),
  approvalStatus: text('approval_status'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const zones = pgTable('zones', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const plots = pgTable(
  'plots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    zoneId: uuid('zone_id').references(() => zones.id).notNull(),
    name: text('name').notNull(),
    code: text('code'),
    notes: text('notes'),
    // Covers `notes` only. `name`, `code` and `cropType` are lookup keys
    // (`lower(name)` match in lot-enrich, playbook keys) and stay verbatim.
    sourceLocale: text('source_locale'),
    translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
    translationAttempts: integer('translation_attempts').default(0).notNull(),
    cropType: text('crop_type').notNull(),
    cropVariety: text('crop_variety'),
    areaAcres: text('area_acres'),
    plantCount: integer('plant_count'),
    latitude: text('latitude'),
    longitude: text('longitude'),
    boundaryGeojson: jsonb('boundary_geojson'),
    active: boolean('active').default(true).notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('plots_farm_zone_code_uq').on(t.farmId, t.zoneId, t.code),
  ],
)

export const plantingUnits = pgTable('planting_units', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  plotId: uuid('plot_id').references(() => plots.id).notNull(),
  label: text('label').notNull(),
  unitType: text('unit_type').notNull(),
  status: text('status').default('active').notNull(),
  plantedAt: timestamp('planted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const tasks = pgTable('tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  plotId: uuid('plot_id').references(() => plots.id),
  title: text('title').notNull(),
  description: text('description'),
  templateId: uuid('template_id').references(() => taskTemplates.id),
  actionType: text('action_type'),
  actionPayload: jsonb('action_payload').$type<Record<string, unknown>>(),
  photoUrl: text('photo_url'),
  voiceUrl: text('voice_url'),
  latitude: text('latitude'),
  longitude: text('longitude'),
  status: taskStatusEnum('status').default('pending').notNull(),
  assignedToId: uuid('assigned_to_id').references(() => users.id),
  createdById: uuid('created_by_id').references(() => users.id).notNull(),
  dueDate: timestamp('due_date', { withTimezone: true }),
  completionNote: text('completion_note'),
  rejectionReason: text('rejection_reason'),
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  approvedById: uuid('approved_by_id').references(() => users.id),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const attendanceSessions = pgTable(
  'attendance_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    clockInAt: timestamp('clock_in_at', { withTimezone: true }).defaultNow().notNull(),
    clockOutAt: timestamp('clock_out_at', { withTimezone: true }),
    monthlyWageSnapshotNgn: integer('monthly_wage_snapshot_ngn').notNull(),
    plotId: uuid('plot_id').references(() => plots.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    notes: text('notes'),
    workSummary: text('work_summary'),
    sourceLocale: text('source_locale'),
    translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
    translationAttempts: integer('translation_attempts').default(0).notNull(),
    correctedById: uuid('corrected_by_id').references(() => users.id, { onDelete: 'set null' }),
    correctedAt: timestamp('corrected_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('attendance_sessions_one_open_per_user_uq')
      .on(t.farmId, t.userId)
      .where(sql`${t.clockOutAt} is null`),
    index('attendance_sessions_farm_clock_in_idx').on(t.farmId, t.clockInAt),
    index('attendance_sessions_task_idx').on(t.taskId).where(sql`${t.taskId} is not null`),
    check('attendance_sessions_wage_nonnegative', sql`${t.monthlyWageSnapshotNgn} >= 0`),
    check(
      'attendance_sessions_time_order',
      sql`${t.clockOutAt} is null or ${t.clockOutAt} >= ${t.clockInAt}`,
    ),
  ],
)

export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    // Optional link to a sellable catalogue product. At most one stock row per
    // product per farm so dispatch/harvest can move finished-goods automatically.
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull(),
    unit: inventoryUnitEnum('unit').notNull(),
    quantity: integer('quantity').default(0).notNull(),
    reorderLevel: integer('reorder_level').default(10).notNull(),
    varianceTolerance: integer('variance_tolerance').default(0).notNull(),
    costPerUnit: integer('cost_per_unit'),
    supplier: text('supplier'),
    expiryDate: timestamp('expiry_date', { withTimezone: true }),
    // Worker prose ("back of the feed shed"), the same kind of text as
    // `assets.locationText`, so it carries a locale pair and is swept.
    storageLocation: text('storage_location'),
    batchNumber: text('batch_number'),
    sourceLocale: text('source_locale'),
    translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
    translationAttempts: integer('translation_attempts').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('inventory_items_farm_sku_uq').on(t.farmId, t.sku),
    uniqueIndex('inventory_items_farm_product_uq')
      .on(t.farmId, t.productId)
      .where(sql`${t.productId} is not null`),
  ],
)

export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    itemId: uuid('item_id').references(() => inventoryItems.id).notNull(),
    delta: integer('delta').notNull(),
    reason: text('reason').notNull(),
    // `reason` is either worker prose or a machine sentinel ('opening_stock_count',
    // 'task_consumption', 'goods_receipt', 'verified_count_session', 'sale',
    // 'harvest_in', 'spoilage', …); only prose is translated, so sentinel writes
    // must stay 'done'.
    sourceLocale: text('source_locale'),
    translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
    translationAttempts: integer('translation_attempts').default(0).notNull(),
    sourceType: text('source_type'),
    sourceId: uuid('source_id'),
    recordedById: uuid('recorded_by_id').references(() => users.id).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('inventory_movements_source_uq').on(t.farmId, t.sourceType, t.sourceId),
  ],
)

export const suppliers = pgTable('suppliers', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  notes: text('notes'),
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const purchaseOrders = pgTable('purchase_orders', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
  supplierId: uuid('supplier_id').references(() => suppliers.id).notNull(),
  status: purchaseOrderStatusEnum('status').default('draft').notNull(),
  createdById: uuid('created_by_id').references(() => users.id).notNull(),
  approvedById: uuid('approved_by_id').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  notes: text('notes'),
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  expectedAt: timestamp('expected_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const purchaseOrderLines = pgTable('purchase_order_lines', {
  id: uuid('id').defaultRandom().primaryKey(),
  purchaseOrderId: uuid('purchase_order_id')
    .references(() => purchaseOrders.id, { onDelete: 'cascade' })
    .notNull(),
  itemId: uuid('item_id').references(() => inventoryItems.id),
  itemName: text('item_name').notNull(),
  unit: inventoryUnitEnum('unit').notNull(),
  quantityOrdered: integer('quantity_ordered').notNull(),
  quantityReceived: integer('quantity_received').default(0).notNull(),
  unitCostMinor: integer('unit_cost_minor'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    receivedById: uuid('received_by_id').references(() => users.id).notNull(),
    notes: text('notes'),
    sourceLocale: text('source_locale'),
    translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
    translationAttempts: integer('translation_attempts').default(0).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('goods_receipts_po_idempotency_uq').on(t.purchaseOrderId, t.idempotencyKey),
  ],
)

export const goodsReceiptLines = pgTable('goods_receipt_lines', {
  id: uuid('id').defaultRandom().primaryKey(),
  goodsReceiptId: uuid('goods_receipt_id')
    .references(() => goodsReceipts.id, { onDelete: 'cascade' })
    .notNull(),
  purchaseOrderLineId: uuid('purchase_order_line_id').references(() => purchaseOrderLines.id).notNull(),
  itemId: uuid('item_id').references(() => inventoryItems.id).notNull(),
  quantityReceived: integer('quantity_received').notNull(),
  inventoryMovementId: uuid('inventory_movement_id').references(() => inventoryMovements.id).unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const taskInventoryUsage = pgTable('task_inventory_usage', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  itemId: uuid('item_id').references(() => inventoryItems.id).notNull(),
  quantity: integer('quantity').notNull(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  userId: uuid('user_id').references(() => users.id),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const advisoryRecommendationStatusEnum = pgEnum('advisory_recommendation_status', [
  'pending',
  'notified',
  'accepted',
  'ignored',
  'completed',
])
export const advisorySourceTypeEnum = pgEnum('advisory_source_type', [
  'crop_cycle',
  'livestock_batch',
  'weather',
  'farm',
])

export const cropCycles = pgTable('crop_cycles', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  plotId: uuid('plot_id').references(() => plots.id).notNull(),
  cropType: text('crop_type').notNull(),
  stage: cropStageEnum('stage').default('planted').notNull(),
  plantedAt: timestamp('planted_at', { withTimezone: true }).notNull(),
  /** When the current stage began; defaults to plantedAt on create. */
  stageEnteredAt: timestamp('stage_entered_at', { withTimezone: true }).notNull(),
  expectedHarvestAt: timestamp('expected_harvest_at', { withTimezone: true }),
  actualHarvestAt: timestamp('actual_harvest_at', { withTimezone: true }),
  expectedYieldKg: integer('expected_yield_kg'),
  actualYieldKg: integer('actual_yield_kg'),
  /** Why the last lifecycle generation produced nothing. See livestockBatches. */
  agronomySkipReason: text('agronomy_skip_reason'),
  notes: text('notes'),
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

/**
 * How long each stage of one crop cycle is expected to last.
 *
 * This used to be `PLANTAIN_LIFECYCLE` and `COCONUT_LIFECYCLE` in
 * two hardcoded constants: two crops' worth of stage durations, and
 * applied to every farm growing them. A farm on different soil or a different
 * variety had no way to say so, and any other crop got no lifecycle at all.
 *
 * Rows are generated once per cycle from the crop the farmer entered and then
 * belong to the farm. `sequence` orders the stages; `durationDays` is what the
 * expected harvest date and the stage-advance prompts are computed from.
 */
export const cropCycleStages = pgTable(
  'crop_cycle_stages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id)
      .notNull(),
    cropCycleId: uuid('crop_cycle_id')
      .references(() => cropCycles.id, { onDelete: 'cascade' })
      .notNull(),
    stage: cropStageEnum('stage').notNull(),
    sequence: integer('sequence').notNull(),
    durationDays: integer('duration_days').notNull(),
    source: agronomySourceEnum('source').default('generated').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One row per stage per cycle: a cycle cannot be in 'flowering' twice, and a
    // duplicate would double-count toward the expected harvest date.
    uniqueIndex('crop_cycle_stages_cycle_stage_key').on(t.cropCycleId, t.stage),
    index('crop_cycle_stages_cycle_seq_idx').on(t.cropCycleId, t.sequence),
  ],
)

/**
 * The work a crop cycle's stage is expected to need, replacing the
 * `taskSuggestions` literals those constants carried.
 *
 * `templateName` and `description` are prose and carry the locale trio like
 * every other free-text column, so a generated English plan reads back in the
 * worker's language. `offsetDays` counts from the day the stage is entered, not
 * from planting, so a stage that runs long does not drag its tasks out of order.
 */
export const cropCycleTasks = pgTable(
  'crop_cycle_tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id)
      .notNull(),
    cropCycleId: uuid('crop_cycle_id')
      .references(() => cropCycles.id, { onDelete: 'cascade' })
      .notNull(),
    stage: cropStageEnum('stage').notNull(),
    offsetDays: integer('offset_days').notNull(),
    templateName: text('template_name').notNull(),
    description: text('description'),
    defaultDurationHours: integer('default_duration_hours'),
    source: agronomySourceEnum('source').default('generated').notNull(),
    sourceLocale: text('source_locale'),
    translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
    translationAttempts: integer('translation_attempts').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('crop_cycle_tasks_cycle_stage_idx').on(t.cropCycleId, t.stage, t.offsetDays),
    index('crop_cycle_tasks_pending_idx')
      .on(t.farmId)
      .where(sql`translation_status <> 'done'`),
  ],
)

export const advisoryRecommendations = pgTable(
  'advisory_recommendations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    ruleKey: text('rule_key').notNull(),
    sourceType: advisorySourceTypeEnum('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    status: advisoryRecommendationStatusEnum('status').default('pending').notNull(),
    notifyRoles: text('notify_roles').array().default([]).notNull(),
    payload: jsonb('payload').notNull(),
    aiSummary: text('ai_summary'),
    firedAt: timestamp('fired_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('advisory_recommendations_farm_source_rule_uq').on(
      t.farmId,
      t.sourceId,
      t.ruleKey,
    ),
    index('advisory_recommendations_farm_status_idx').on(t.farmId, t.status),
  ],
)

export const advisoryObservations = pgTable(
  'advisory_observations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    loggedAt: timestamp('logged_at', { withTimezone: true }).defaultNow().notNull(),
    sourceType: advisorySourceTypeEnum('source_type'),
    sourceId: text('source_id'),
    tiles: text('tiles').array().default([]).notNull(),
    note: text('note'),
    sourceLocale: text('source_locale'),
    translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
    translationAttempts: integer('translation_attempts').default(0).notNull(),
    createdBy: uuid('created_by')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('advisory_observations_farm_logged_idx').on(t.farmId, t.loggedAt)],
)

export const livestockBatches = pgTable('livestock_batches', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  plotId: uuid('plot_id').references(() => plots.id),
  name: text('name').notNull(),
  species: text('species').notNull(),
  batchType: poultryBatchTypeEnum('batch_type'),
  headCount: integer('head_count').notNull(),
  startCount: integer('start_count'),
  feedUsedKg: integer('feed_used_kg').default(0),
  targetCloseoutAt: timestamp('target_closeout_at', { withTimezone: true }),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull(),
  notes: text('notes'),
  // Covers `notes` only. `species` keeps the farmer's own wording; it is canonicalized
  // by `species-normalize` on write (which also derives `batchType`) and read through
  // `isNoilerBatch`, so it is never translated.
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  /**
   * Growth expectation for THIS batch, in place of the constants the livestock
   * route used to apply to every bird. Null means nobody has established one:
   * the weight estimate is then withheld rather than guessed, because a number
   * on a batch page is read as a measurement.
   */
  startWeightKg: numeric('start_weight_kg', { precision: 6, scale: 3 }),
  targetWeightKg: numeric('target_weight_kg', { precision: 6, scale: 3 }),
  dailyGainKg: numeric('daily_gain_kg', { precision: 6, scale: 4 }),
  /** Expected length of the production cycle, which drives the closeout window. */
  cycleDays: integer('cycle_days'),
  /** Where the growth figures came from, so a farmer's own numbers are never regenerated over. */
  agronomySource: agronomySourceEnum('agronomy_source'),
  /**
   * Why the last generation attempt produced nothing, so a farm looking at an
   * empty calendar is told which it is: the assistant is switched off, the
   * day's budget is spent, or the attempt failed and is worth retrying.
   * Cleared once a plan exists, generated or hand-entered.
   */
  agronomySkipReason: text('agronomy_skip_reason'),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

/**
 * The vaccination and husbandry calendar for one batch.
 *
 * This used to be `BROILER_VACCINATION_SCHEDULE`, a literal in the livestock
 * route applied to every flock on every farm. That is wrong twice over: it is
 * breed-specific veterinary advice presented as if it were the farm's own plan,
 * and it cannot be corrected by the person who actually knows the birds. Rows
 * here are generated once per batch from the species the farmer entered, then
 * belong to the farm: editable, deletable, and never regenerated over.
 *
 * `name` and `vaccine` are prose and carry the locale pair like every other
 * free-text column, so a generated English calendar reads back in the worker's
 * language. `day_offset` counts from the batch's `acquired_at`.
 */
export const livestockScheduleEntries = pgTable(
  'livestock_schedule_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id)
      .notNull(),
    batchId: uuid('batch_id')
      .references(() => livestockBatches.id, { onDelete: 'cascade' })
      .notNull(),
    dayOffset: integer('day_offset').notNull(),
    name: text('name').notNull(),
    vaccine: text('vaccine'),
    source: agronomySourceEnum('source').default('generated').notNull(),
    sourceLocale: text('source_locale'),
    translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
    translationAttempts: integer('translation_attempts').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('livestock_schedule_batch_day_idx').on(t.batchId, t.dayOffset),
    index('livestock_schedule_pending_idx')
      .on(t.farmId)
      .where(sql`translation_status <> 'done'`),
  ],
)

export const livestockLogs = pgTable('livestock_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  batchId: uuid('batch_id').references(() => livestockBatches.id).notNull(),
  logType: livestockLogTypeEnum('log_type').notNull(),
  headCount: integer('head_count'),
  notes: text('notes'),
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  recordedById: uuid('recorded_by_id').references(() => users.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const harvestLots = pgTable('harvest_lots', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  lotCode: text('lot_code').notNull(),
  /** High-entropy token for public traceability URLs (not guessable like lotCode). */
  publicToken: text('public_token')
    .notNull()
    .$defaultFn(() => randomUUID()),
  plotId: uuid('plot_id').references(() => plots.id),
  cropCycleId: uuid('crop_cycle_id').references(() => cropCycles.id),
  /** Linked customer/staff order that spawned this lot (auto-create on place). */
  orderId: uuid('order_id'),
  productName: text('product_name').notNull(),
  /** Numeric amount; interpret with `unit` (`kg` or `crates`). */
  quantityKg: integer('quantity_kg').notNull(),
  unit: text('unit').default('kg').notNull(),
  publicNotes: text('public_notes'),
  internalNotes: text('internal_notes'),
  // Covers both note columns. `lotCode`, `publicToken` and `productName` are
  // identifiers shown verbatim on public traceability pages.
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  // Optional field evidence (allowlisted data URL) attached when a worker or
  // supervisor reports the harvest from the field.
  photoUrl: text('photo_url'),
  harvestedAt: timestamp('harvested_at', { withTimezone: true }).notNull(),
  // Who created the lot (staff member). Founder-created lots keep this null for
  // legacy rows; new reports always record the reporter.
  reportedById: uuid('reported_by_id').references(() => users.id),
  // Verification gate: 'reported' (worker submission, hidden from buyers) ->
  // 'verified' (public) or 'rejected'. Owner/supervisor-created lots are
  // 'verified' immediately. Public traceability shows verified lots only.
  verificationStatus: text('verification_status').default('verified').notNull(),
  verifiedById: uuid('verified_by_id').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const orders = pgTable('orders', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  customerName: text('customer_name').notNull(),
  customerPhone: text('customer_phone'),
  status: orderStatusEnum('status').default('pending').notNull(),
  // Existing rows default to not_required; paid-path orders set unpaid at create.
  paymentStatus: paymentStatusEnum('payment_status').default('not_required').notNull(),
  totalAmount: integer('total_amount').default(0).notNull(),
  currency: text('currency').default('NGN').notNull(),
  lotId: uuid('lot_id').references(() => harvestLots.id),
  // Set when the order was placed by a customer via a chat bot; null for
  // staff-entered orders. `source` records the channel it came in on.
  customerContactId: uuid('customer_contact_id').references(() => customerContacts.id),
  source: text('source').default('staff').notNull(),
  notes: text('notes'),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  deliveryPhotoUrl: text('delivery_photo_url'),
  customerFeedback: text('customer_feedback'),
  customerFeedbackAt: timestamp('customer_feedback_at', { withTimezone: true }),
  // Covers `notes` and `customerFeedback`. `customerName` is a proper noun and
  // `cancelledBy` holds the sentinel 'customer'.
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  feedbackRequestedAt: timestamp('feedback_requested_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledBy: text('cancelled_by'),
  refundRequestedAt: timestamp('refund_requested_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// Sellable catalog shown by the customer order bot. Prices are in kobo (integer
// minor units); price_kobo = 0 means "price on request" until a Founder sets it.
export const products = pgTable(
  'products',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    unit: text('unit').default('unit').notNull(),
    priceKobo: integer('price_kobo').default(0).notNull(),
    currency: text('currency').default('NGN').notNull(),
    active: boolean('active').default(true).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('products_farm_sku_uq').on(t.farmId, t.sku)],
)

// Customer-facing shop identity. This is deliberately separate from staff
// users/RBAC: customers can see only their own profile, orders and trace links.
export const customerAccounts = pgTable(
  'customer_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    phone: text('phone'),
    passwordHash: text('password_hash').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('customer_accounts_farm_email_uq').on(t.farmId, t.email)],
)

export const customerAccountSessions = pgTable('customer_account_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id')
    .references(() => customerAccounts.id, { onDelete: 'cascade' })
    .notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const customerAccountLinkCodes = pgTable('customer_account_link_codes', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id')
    .references(() => customerAccounts.id, { onDelete: 'cascade' })
    .notNull(),
  codeHash: text('code_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const customerPasswordResetTokens = pgTable('customer_password_reset_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id')
    .references(() => customerAccounts.id, { onDelete: 'cascade' })
    .notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const customerEmailVerificationTokens = pgTable('customer_email_verification_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id')
    .references(() => customerAccounts.id, { onDelete: 'cascade' })
    .notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// A buyer who reached the farm through a chat bot. Anonymous (no login / RBAC);
// the customer analogue of the staff telegram_link. Scoped per farm + channel.
export const customerContacts = pgTable(
  'customer_contacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    customerAccountId: uuid('customer_account_id').references(() => customerAccounts.id, {
      onDelete: 'set null',
    }),
    channel: text('channel').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name'),
    phone: text('phone'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('customer_contacts_farm_channel_external_uq').on(t.farmId, t.channel, t.externalId)],
)

export const orderItems = pgTable('order_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  orderId: uuid('order_id').references(() => orders.id).notNull(),
  productId: uuid('product_id').references(() => products.id),
  productName: text('product_name').notNull(),
  unit: text('unit').default('unit').notNull(),
  unitPriceKobo: integer('unit_price_kobo').default(0).notNull(),
  quantity: integer('quantity').notNull(),
  lineTotalKobo: integer('line_total_kobo').default(0).notNull(),
})

// Paystack (and future providers) payment attempts for an order. Status is kept
// separate from fulfilment (`orders.status`). Amounts are always kobo.
export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    orderId: uuid('order_id').references(() => orders.id).notNull(),
    provider: text('provider').default('paystack').notNull(),
    providerReference: text('provider_reference').notNull().unique(),
    accessCode: text('access_code'),
    amountKobo: integer('amount_kobo').notNull(),
    currency: text('currency').default('NGN').notNull(),
    // initiated | success | failed | abandoned
    status: text('status').default('initiated').notNull(),
    providerEventId: text('provider_event_id'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  (t) => [index('payment_attempts_order_id_idx').on(t.orderId)],
)

// Immutable invoice snapshot for an order (printable / public link).
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    orderId: uuid('order_id').references(() => orders.id).notNull(),
    invoiceNumber: text('invoice_number').notNull(),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    currency: text('currency').default('NGN').notNull(),
    amountKobo: integer('amount_kobo').notNull(),
    publicToken: text('public_token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('invoices_order_id_idx').on(t.orderId)],
)

// One receipt per successful payment attempt, linked to its invoice.
export const paymentReceipts = pgTable('payment_receipts', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  invoiceId: uuid('invoice_id').references(() => invoices.id).notNull(),
  paymentAttemptId: uuid('payment_attempt_id').references(() => paymentAttempts.id).notNull(),
  receiptNumber: text('receipt_number').notNull(),
  amountKobo: integer('amount_kobo').notNull(),
  paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
  publicToken: text('public_token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const paymentRefunds = pgTable(
  'payment_refunds',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    paymentAttemptId: uuid('payment_attempt_id').references(() => paymentAttempts.id).notNull(),
    orderId: uuid('order_id').references(() => orders.id).notNull(),
    amountKobo: integer('amount_kobo').notNull(),
    providerRefundId: text('provider_refund_id'),
    // pending | success | failed
    status: text('status').default('pending').notNull(),
    reason: text('reason'),
    sourceLocale: text('source_locale'),
    translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
    translationAttempts: integer('translation_attempts').default(0).notNull(),
    createdById: uuid('created_by_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('payment_refunds_order_id_idx').on(t.orderId)],
)

// Ephemeral shopping-cart / conversation state for a customer chat. One row per
// (farm, channel, external_id); rewritten as the buyer moves through the flow.
export const customerChatSessions = pgTable(
  'customer_chat_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    channel: text('channel').notNull(),
    externalId: text('external_id').notNull(),
    step: text('step').default('idle').notNull(),
    cart: jsonb('cart'),
    draft: jsonb('draft'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('customer_chat_sessions_farm_channel_external_uq').on(t.farmId, t.channel, t.externalId),
  ],
)

// Register of equipment/tools/PPE the farm owns. Founders + supervisors define
// entries; daily state is tracked in asset_logs. Pool model: one row per item
// type with a quantity_owned; assigned_to_id optionally ties PPE to a worker.
export const assets = pgTable('assets', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  name: text('name').notNull(),
  // 'ppe' | 'tool' | 'vehicle' | 'irrigation' | 'other'
  category: text('category').default('other').notNull(),
  unit: text('unit').default('unit').notNull(),
  quantityOwned: integer('quantity_owned').default(0).notNull(),
  trackingMode: text('tracking_mode').default('pool').notNull(),
  assetTag: text('asset_tag'),
  manufacturer: text('manufacturer'),
  model: text('model'),
  serialNumber: text('serial_number'),
  acquisitionDate: timestamp('acquisition_date', { withTimezone: true }),
  acquisitionCostMinor: integer('acquisition_cost_minor'),
  currency: text('currency').default('NGN'),
  zoneId: uuid('zone_id').references(() => zones.id),
  plotId: uuid('plot_id').references(() => plots.id),
  locationText: text('location_text'),
  operationalStatus: text('operational_status').default('operational').notNull(),
  maintenanceIntervalDays: integer('maintenance_interval_days'),
  nextServiceAt: timestamp('next_service_at', { withTimezone: true }),
  disposedAt: timestamp('disposed_at', { withTimezone: true }),
  assignedToId: uuid('assigned_to_id').references(() => users.id),
  notes: text('notes'),
  // Covers `notes` only. `name` and `assetTag` are matched lowercase by
  // `resolveAssetByQuery`, and `category` is an i18n message key in the app.
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  active: boolean('active').default(true).notNull(),
  createdById: uuid('created_by_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const assetEvents = pgTable('asset_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'cascade' }).notNull(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  eventType: text('event_type').notNull(),
  eventDate: timestamp('event_date', { withTimezone: true }).defaultNow().notNull(),
  costMinor: integer('cost_minor'),
  notes: text('notes'),
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  evidenceUrl: text('evidence_url'),
  recordedById: uuid('recorded_by_id').references(() => users.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// One daily check per asset: how many are present/working, damaged count and
// condition, optional photo evidence. Verified by a supervisor/owner (mirrors
// the task approval shape) so the Founder sees a trusted availability picture.
export const assetLogs = pgTable('asset_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  assetId: uuid('asset_id').references(() => assets.id).notNull(),
  logDate: timestamp('log_date', { withTimezone: true }).defaultNow().notNull(),
  countAvailable: integer('count_available').default(0).notNull(),
  countDamaged: integer('count_damaged').default(0).notNull(),
  // 'good' | 'fair' | 'damaged' | free text
  condition: text('condition').default('good').notNull(),
  note: text('note'),
  // Covers `note` only: the app renders `condition` through the i18n key
  // `assets.cond.<condition>`, so translating it would break the label lookup.
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  photoUrl: text('photo_url'),
  recordedById: uuid('recorded_by_id').references(() => users.id).notNull(),
  // 'reported' | 'verified' | 'rejected'
  verificationStatus: text('verification_status').default('reported').notNull(),
  verifiedById: uuid('verified_by_id').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const fieldReports = pgTable(
  'field_reports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    createdById: uuid('created_by_id').references(() => users.id).notNull(),
    category: text('category').notNull(),
    severity: text('severity').default('normal').notNull(),
    description: text('description').notNull(),
    plotId: uuid('plot_id').references(() => plots.id, { onDelete: 'set null' }),
    batchId: uuid('batch_id').references(() => livestockBatches.id, { onDelete: 'set null' }),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    photoUrl: text('photo_url'),
    status: text('status').default('open').notNull(),
    assignedToId: uuid('assigned_to_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedById: uuid('resolved_by_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('field_reports_farm_status_created_idx').on(t.farmId, t.status, t.createdAt)],
)

export const customerSupportTickets = pgTable(
  'customer_support_tickets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    reference: text('reference').notNull(),
    contactId: uuid('contact_id').references(() => customerContacts.id, { onDelete: 'set null' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    channel: text('channel').default('staff').notNull(),
    category: text('category').default('complaint').notNull(),
    priority: text('priority').default('normal').notNull(),
    status: text('status').default('open').notNull(),
    description: text('description').notNull(),
    assignedToId: uuid('assigned_to_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedById: uuid('resolved_by_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('customer_support_tickets_farm_reference_uq').on(t.farmId, t.reference),
    index('customer_support_tickets_farm_status_created_idx').on(t.farmId, t.status, t.createdAt),
  ],
)

// Every question a customer asks the order bot (product availability, farm info,
// general enquiries). Powers the Founder "most asked" view and the bot's
// suggested-questions prompt. No login - tied to a customer_contact when known.
export const customerInquiries = pgTable('customer_inquiries', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  contactId: uuid('contact_id').references(() => customerContacts.id),
  channel: text('channel').notNull(),
  question: text('question').notNull(),
  // Lowercased/normalized form used to group "same" questions for counts.
  normalized: text('normalized').notNull(),
  // Covers `question`. `normalized` is a GROUP BY key: it must be derived from
  // whatever `question` ends up holding, or the counts split per language.
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  // How we answered: 'catalog' | 'llm' | 'faq' | 'suggested'
  answeredVia: text('answered_via').default('faq').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const expenses = pgTable('expenses', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  category: expenseCategoryEnum('category').notNull(),
  description: text('description').notNull(),
  amount: integer('amount').notNull(),
  currency: text('currency').default('NGN').notNull(),
  vendor: text('vendor'),
  receiptRef: text('receipt_ref'),
  source: text('source').default('manual').notNull(),
  inboundMessageId: text('inbound_message_id'),
  attachmentFilename: text('attachment_filename'),
  attachmentStorageKey: text('attachment_storage_key'),
  attachmentMimeType: text('attachment_mime_type'),
  extractionMethod: text('extraction_method'),
  extractionStatus: text('extraction_status'),
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  approvalStatus: text('approval_status').default('approved').notNull(),
  recordedById: uuid('recorded_by_id').references(() => users.id).notNull(),
  expenseDate: timestamp('expense_date', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const expenseLabels = pgTable(
  'expense_labels',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id)
      .notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('expense_labels_farm_slug_uq').on(t.farmId, t.slug)],
)

export const expenseLabelLinks = pgTable(
  'expense_label_links',
  {
    expenseId: uuid('expense_id')
      .references(() => expenses.id, { onDelete: 'cascade' })
      .notNull(),
    labelId: uuid('label_id')
      .references(() => expenseLabels.id, { onDelete: 'cascade' })
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.expenseId, t.labelId] })],
)

export const financeInboundEvents = pgTable('finance_inbound_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  svixId: text('svix_id').notNull().unique(),
  resendEmailId: text('resend_email_id'),
  processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
  expenseId: uuid('expense_id').references(() => expenses.id, { onDelete: 'set null' }),
  status: text('status').default('processed').notNull(),
  detail: text('detail'),
})

export const momentSubmissions = pgTable(
  'moment_submissions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id)
      .notNull(),
    status: text('status').default('pending').notNull(),
    submitterName: text('submitter_name'),
    submitterEmail: text('submitter_email'),
    consent: boolean('consent').default(false).notNull(),
    mediaKind: text('media_kind').default('image').notNull(),
    mimeType: text('mime_type').notNull(),
    originalFilename: text('original_filename'),
    storageKey: text('storage_key').notNull(),
    posterStorageKey: text('poster_storage_key'),
    byteSize: integer('byte_size').default(0).notNull(),
    durationSeconds: integer('duration_seconds'),
    reviewNote: text('review_note'),
    reviewedById: uuid('reviewed_by_id').references(() => users.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('moment_submissions_farm_status_idx').on(t.farmId, t.status, t.createdAt)],
)

export const careerPosts = pgTable(
  'career_posts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    department: text('department'),
    location: text('location'),
    employmentType: text('employment_type').default('full_time').notNull(),
    summary: text('summary').notNull(),
    bodyMarkdown: text('body_markdown').notNull(),
    applyEmail: text('apply_email').default('hello@trovara.farm').notNull(),
    published: boolean('published').default(false).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdById: uuid('created_by_id')
      .references(() => users.id, { onDelete: 'restrict' })
      .notNull(),
    updatedById: uuid('updated_by_id')
      .references(() => users.id, { onDelete: 'restrict' })
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('career_posts_farm_slug_uq').on(t.farmId, t.slug),
    index('career_posts_farm_created_idx').on(t.farmId, t.createdAt),
    index('career_posts_public_idx')
      .on(t.farmId, t.publishedAt)
      .where(sql`${t.published} = true`),
    check('career_posts_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check(
      'career_posts_published_at_consistent',
      sql`(${t.published} = false) or (${t.publishedAt} is not null)`,
    ),
  ],
)

export const cropCensusSurveys = pgTable('crop_census_surveys', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  plotId: uuid('plot_id').references(() => plots.id).notNull(),
  taskId: uuid('task_id').references(() => tasks.id),
  cropType: text('crop_type').notNull(),
  cropVariety: text('crop_variety'),
  plantCount: integer('plant_count').notNull(),
  minHeight: text('min_height'),
  maxHeight: text('max_height'),
  avgHeight: text('avg_height'),
  heightUnit: text('height_unit').default('cm').notNull(),
  sampleSize: integer('sample_size'),
  countingMethod: text('counting_method'),
  conditionNotes: text('condition_notes'),
  mortalityNotes: text('mortality_notes'),
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  surveyedAt: timestamp('surveyed_at', { withTimezone: true }).defaultNow().notNull(),
  latitude: text('latitude'),
  longitude: text('longitude'),
  recordedById: uuid('recorded_by_id').references(() => users.id).notNull(),
  verificationStatus: text('verification_status').default('reported').notNull(),
  verifiedById: uuid('verified_by_id').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const cropCensusEvidence = pgTable('crop_census_evidence', {
  id: uuid('id').defaultRandom().primaryKey(),
  surveyId: uuid('survey_id')
    .references(() => cropCensusSurveys.id, { onDelete: 'cascade' })
    .notNull(),
  kind: text('kind').notNull(),
  evidenceUrl: text('evidence_url').notNull(),
  createdById: uuid('created_by_id').references(() => users.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const inventoryCountSessions = pgTable('inventory_count_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  taskId: uuid('task_id').references(() => tasks.id),
  locationText: text('location_text'),
  status: text('status').default('submitted').notNull(),
  hasVariance: boolean('has_variance').default(false).notNull(),
  recordedById: uuid('recorded_by_id').references(() => users.id).notNull(),
  verifiedById: uuid('verified_by_id').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const inventoryCountLines = pgTable('inventory_count_lines', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id')
    .references(() => inventoryCountSessions.id, { onDelete: 'cascade' })
    .notNull(),
  itemId: uuid('item_id').references(() => inventoryItems.id),
  itemName: text('item_name').notNull(),
  category: text('category').default('supplies').notNull(),
  unit: text('unit').default('units').notNull(),
  countedQuantity: integer('counted_quantity').notNull(),
  expectedQuantity: integer('expected_quantity'),
  variance: integer('variance'),
  notes: text('notes'),
  // Covers `notes`. This table has no `farm_id`: the retry job must reach the
  // farm through `session_id -> inventory_count_sessions.farm_id`.
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const inventoryReconciliationAlerts = pgTable(
  'inventory_reconciliation_alerts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    sessionId: uuid('session_id')
      .references(() => inventoryCountSessions.id, { onDelete: 'cascade' })
      .notNull(),
    lineId: uuid('line_id')
      .references(() => inventoryCountLines.id, { onDelete: 'cascade' })
      .notNull(),
    itemId: uuid('item_id').references(() => inventoryItems.id, { onDelete: 'cascade' }).notNull(),
    sku: text('sku').notNull(),
    expectedQuantity: integer('expected_quantity').notNull(),
    countedQuantity: integer('counted_quantity').notNull(),
    variance: integer('variance').notNull(),
    tolerance: integer('tolerance').default(0).notNull(),
    status: text('status').default('open').notNull(),
    acknowledgedById: uuid('acknowledged_by_id').references(() => users.id, { onDelete: 'set null' }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    resolvedById: uuid('resolved_by_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('inventory_reconciliation_alerts_line_uq').on(t.lineId),
    index('inventory_reconciliation_alerts_farm_status_created_idx').on(
      t.farmId,
      t.status,
      t.createdAt,
    ),
  ],
)

/** Continuous input/output leakage alerts (period shrink, not count-day variance). */
export const inventoryShrinkAlerts = pgTable(
  'inventory_shrink_alerts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    itemId: uuid('item_id').references(() => inventoryItems.id, { onDelete: 'cascade' }).notNull(),
    sku: text('sku').notNull(),
    // 'unexplained_out' | 'sales_stock_mismatch'
    alertType: text('alert_type').notNull(),
    periodDays: integer('period_days').default(30).notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    qtyIn: integer('qty_in').default(0).notNull(),
    qtyOutSale: integer('qty_out_sale').default(0).notNull(),
    qtyOutTask: integer('qty_out_task').default(0).notNull(),
    qtyOutSpoilage: integer('qty_out_spoilage').default(0).notNull(),
    qtyOutOther: integer('qty_out_other').default(0).notNull(),
    soldQty: integer('sold_qty').default(0).notNull(),
    unexplainedOut: integer('unexplained_out').default(0).notNull(),
    tolerance: integer('tolerance').default(0).notNull(),
    status: text('status').default('open').notNull(),
    acknowledgedById: uuid('acknowledged_by_id').references(() => users.id, { onDelete: 'set null' }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    resolvedById: uuid('resolved_by_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('inventory_shrink_alerts_open_item_type_uq')
      .on(t.farmId, t.itemId, t.alertType)
      .where(sql`${t.status} <> 'resolved'`),
    index('inventory_shrink_alerts_farm_status_created_idx').on(t.farmId, t.status, t.createdAt),
  ],
)

export const actionDrafts = pgTable('action_drafts', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  channel: text('channel').default('web').notNull(),
  externalChatId: text('external_chat_id'),
  actionType: text('action_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
  status: text('status').default('pending').notNull(),
  sourceLocale: text('source_locale'),
  translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
  translationAttempts: integer('translation_attempts').default(0).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  telegramMessageId: text('telegram_message_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const telegramProcessedUpdates = pgTable(
  'telegram_processed_updates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    botKey: text('bot_key').notNull(),
    updateId: integer('update_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('telegram_processed_updates_bot_update_uq').on(t.botKey, t.updateId)],
)

/**
 * Display cache for canonical English text rendered into another locale.
 * Keyed by a hash of the English source, so one translation of a task title
 * serves every viewer reading that language.
 */
export const contentTranslations = pgTable(
  'content_translations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    contentHash: text('content_hash').notNull(),
    targetLocale: text('target_locale').notNull(),
    translatedText: text('translated_text').notNull(),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('content_translations_hash_locale_uq').on(t.contentHash, t.targetLocale)],
)

/**
 * Cache for LLM-generated advisory prose, keyed by a fingerprint of the farm
 * state that produced it (rule, crop, stage, bucketed day-in-stage, bucketed
 * weather). Unchanged state reuses one generation across viewers and days.
 */
export const generatedAdvice = pgTable(
  'generated_advice',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    fingerprint: text('fingerprint').notNull(),
    ruleKey: text('rule_key').notNull(),
    happeningNow: text('happening_now').notNull(),
    whatNext: text('what_next').notNull(),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('generated_advice_farm_fingerprint_uq').on(t.farmId, t.fingerprint)],
)

export type UserRole = 'owner' | 'supervisor' | 'field_worker' | 'sales'
export type PreferredLocale = 'en' | 'yo' | 'pcm' | 'fr'
export type TranslationStatus = 'done' | 'pending' | 'failed'
export type TaskStatus = 'pending' | 'in_progress' | 'awaiting_approval' | 'completed' | 'rejected'
export type PaymentStatus =
  | 'unpaid'
  | 'paid'
  | 'not_required'
  | 'refunded'
  | 'partially_refunded'
  | 'refund_pending'
