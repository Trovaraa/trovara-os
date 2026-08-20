import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  integer,
  numeric,
  pgEnum,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  check,
  primaryKey,
  foreignKey,
  vector,
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
  'survey_followup',
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

export const permissionTeams = pgTable(
  'permission_teams',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    name: text('name').notNull(),
    description: text('description'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('permission_teams_farm_name_uq').on(t.farmId, t.name)],
)

export const permissionTeamPermissions = pgTable(
  'permission_team_permissions',
  {
    teamId: uuid('team_id')
      .references(() => permissionTeams.id, { onDelete: 'cascade' })
      .notNull(),
    permissionKey: text('permission_key').notNull(),
  },
  (t) => [uniqueIndex('permission_team_permissions_pk').on(t.teamId, t.permissionKey)],
)

export const permissionTeamMembers = pgTable(
  'permission_team_members',
  {
    teamId: uuid('team_id')
      .references(() => permissionTeams.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('permission_team_members_pk').on(t.teamId, t.userId),
    index('permission_team_members_user_idx').on(t.userId),
  ],
)

export const userPermissionOverrides = pgTable(
  'user_permission_overrides',
  {
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    permissionKey: text('permission_key').notNull(),
    effect: text('effect').notNull(),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('user_permission_overrides_pk').on(t.userId, t.permissionKey),
    index('user_permission_overrides_farm_idx').on(t.farmId),
    check('user_permission_overrides_effect_check', sql`${t.effect} in ('allow', 'deny')`),
  ],
)

export const operationGuidelines = pgTable(
  'operation_guidelines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    title: text('title').notNull(),
    category: text('category').notNull(),
    body: text('body').notNull(),
    audience: text('audience').default('all').notNull(),
    status: text('status').default('draft').notNull(),
    version: integer('version').default(1).notNull(),
    reviewDueAt: timestamp('review_due_at', { withTimezone: true }),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    approvedById: uuid('approved_by_id').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    activeVersionId: uuid('active_version_id'),
    activeIndexGenerationId: uuid('active_index_generation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('operation_guidelines_farm_status_idx').on(t.farmId, t.status),
    check(
      'operation_guidelines_audience_check',
      sql`${t.audience} in ('all', 'management', 'finance', 'operations', 'sales')`,
    ),
    check(
      'operation_guidelines_status_check',
      sql`${t.status} in ('draft', 'indexing', 'approved', 'archived')`,
    ),
  ],
)

export const operationGuidelineDocuments = pgTable(
  'operation_guideline_documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    guidelineId: uuid('guideline_id').references(() => operationGuidelines.id, {
      onDelete: 'set null',
    }),
    originalFilename: text('original_filename').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    storageBucket: text('storage_bucket'),
    cleanStorageKey: text('clean_storage_key'),
    extractionStatus: text('extraction_status').default('queued').notNull(),
    scanStatus: text('scan_status').default('queued').notNull(),
    scanResult: text('scan_result'),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    ocrStatus: text('ocr_status').default('pending').notNull(),
    ocrConfidence: numeric('ocr_confidence', { precision: 5, scale: 2 }),
    extractedText: text('extracted_text').default('').notNull(),
    extractionWarnings: jsonb('extraction_warnings').$type<string[]>().default([]).notNull(),
    uploadedById: uuid('uploaded_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('operation_guideline_documents_farm_status_idx').on(t.farmId, t.extractionStatus),
    index('operation_guideline_documents_farm_hash_idx').on(t.farmId, t.sha256),
    check(
      'operation_guideline_documents_status_check',
      sql`${t.extractionStatus} in ('queued', 'scanning', 'extracting', 'needs_review', 'draft_created', 'failed', 'quarantined', 'discarded')`,
    ),
    check('operation_guideline_documents_scan_status_check', sql`${t.scanStatus} in ('queued', 'scanning', 'clean', 'infected', 'error')`),
    check('operation_guideline_documents_ocr_status_check', sql`${t.ocrStatus} in ('pending', 'not_needed', 'processing', 'completed', 'failed')`),
  ],
)

export const operationGuidelineVersions = pgTable(
  'operation_guideline_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    guidelineId: uuid('guideline_id').references(() => operationGuidelines.id, { onDelete: 'cascade' }).notNull(),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    category: text('category').notNull(),
    body: text('body').notNull(),
    audience: text('audience').notNull(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    contentSha256: text('content_sha256').notNull(),
    sourceDocumentId: uuid('source_document_id').references(() => operationGuidelineDocuments.id, { onDelete: 'set null' }),
    approvedById: uuid('approved_by_id').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('operation_guideline_versions_guideline_version_uq').on(t.guidelineId, t.version),
    index('operation_guideline_versions_farm_guideline_idx').on(t.farmId, t.guidelineId),
  ],
)

export const operationGuidelineIndexGenerations = pgTable(
  'operation_guideline_index_generations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    guidelineId: uuid('guideline_id').references(() => operationGuidelines.id, { onDelete: 'cascade' }).notNull(),
    versionId: uuid('version_id').references(() => operationGuidelineVersions.id, { onDelete: 'cascade' }).notNull(),
    status: text('status').default('building').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    chunkCount: integer('chunk_count').default(0).notNull(),
    validationError: text('validation_error'),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('operation_guideline_index_generations_farm_status_idx').on(t.farmId, t.status),
    check('operation_guideline_index_generations_status_check', sql`${t.status} in ('building', 'validated', 'active', 'failed', 'retired')`),
  ],
)

export const operationGuidelineChunks = pgTable(
  'operation_guideline_chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    guidelineId: uuid('guideline_id')
      .references(() => operationGuidelines.id, { onDelete: 'cascade' })
      .notNull(),
    documentId: uuid('document_id').references(() => operationGuidelineDocuments.id, {
      onDelete: 'set null',
    }),
    versionId: uuid('version_id').references(() => operationGuidelineVersions.id, { onDelete: 'cascade' }),
    generationId: uuid('generation_id').references(() => operationGuidelineIndexGenerations.id, { onDelete: 'cascade' }),
    guidelineVersion: integer('guideline_version').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    heading: text('heading'),
    sourcePage: integer('source_page'),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    embeddingModel: text('embedding_model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('operation_guideline_chunks_version_chunk_uq').on(
      t.guidelineId,
      t.guidelineVersion,
      t.chunkIndex,
    ),
    index('operation_guideline_chunks_farm_guideline_idx').on(t.farmId, t.guidelineId),
    index('operation_guideline_chunks_embedding_hnsw_idx').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
  ],
)

export const knowledgeJobs = pgTable(
  'knowledge_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    type: text('type').notNull(),
    status: text('status').default('queued').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
    progress: integer('progress').default(0).notNull(),
    attempts: integer('attempts').default(0).notNull(),
    maxAttempts: integer('max_attempts').default(3).notNull(),
    runAfter: timestamp('run_after', { withTimezone: true }).defaultNow().notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('knowledge_jobs_claim_idx').on(t.status, t.runAfter, t.createdAt),
    index('knowledge_jobs_farm_type_idx').on(t.farmId, t.type),
    check('knowledge_jobs_type_check', sql`${t.type} in ('document_process', 'guideline_index', 'retrieval_evaluation')`),
    check('knowledge_jobs_status_check', sql`${t.status} in ('queued', 'running', 'succeeded', 'failed', 'dead_letter')`),
    check('knowledge_jobs_progress_check', sql`${t.progress} between 0 and 100`),
  ],
)

export const knowledgeEvaluationCases = pgTable(
  'knowledge_evaluation_cases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    question: text('question').notNull(),
    expectedGuidelineId: uuid('expected_guideline_id').references(() => operationGuidelines.id, { onDelete: 'cascade' }).notNull(),
    expectedText: text('expected_text'),
    audience: text('audience').default('all').notNull(),
    language: text('language').default('en').notNull(),
    active: boolean('active').default(true).notNull(),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('knowledge_evaluation_cases_farm_active_idx').on(t.farmId, t.active)],
)

export const knowledgeEvaluationRuns = pgTable(
  'knowledge_evaluation_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    status: text('status').default('queued').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    totalCases: integer('total_cases').default(0).notNull(),
    passedCases: integer('passed_cases').default(0).notNull(),
    meanReciprocalRank: numeric('mean_reciprocal_rank', { precision: 7, scale: 6 }),
    permissionLeaks: integer('permission_leaks').default(0).notNull(),
    averageLatencyMs: integer('average_latency_ms'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('knowledge_evaluation_runs_farm_created_idx').on(t.farmId, t.createdAt),
    check('knowledge_evaluation_runs_status_check', sql`${t.status} in ('queued', 'running', 'succeeded', 'failed')`),
  ],
)

export const knowledgeEvaluationResults = pgTable(
  'knowledge_evaluation_results',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id').references(() => knowledgeEvaluationRuns.id, { onDelete: 'cascade' }).notNull(),
    caseId: uuid('case_id').references(() => knowledgeEvaluationCases.id, { onDelete: 'cascade' }).notNull(),
    retrievedGuidelineIds: jsonb('retrieved_guideline_ids').$type<string[]>().default([]).notNull(),
    expectedRank: integer('expected_rank'),
    passed: boolean('passed').default(false).notNull(),
    permissionLeak: boolean('permission_leak').default(false).notNull(),
    latencyMs: integer('latency_ms').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('knowledge_evaluation_results_run_case_uq').on(t.runId, t.caseId)],
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

export const portalVaultShares = pgTable(
  'portal_vault_shares',
  {
    entryId: uuid('entry_id')
      .references(() => portalVaultEntries.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    sharedById: uuid('shared_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('portal_vault_shares_pk').on(t.entryId, t.userId),
    index('portal_vault_shares_user_idx').on(t.userId),
  ],
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
    processingLeaseToken: text('processing_lease_token'),
    processingLeaseExpiresAt: timestamp('processing_lease_expires_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('brand_assets_farm_idx').on(t.farmId),
    uniqueIndex('brand_assets_farm_filename_uq').on(t.farmId, t.filename),
    uniqueIndex('brand_assets_farm_id_uq').on(t.farmId, t.id),
    index('brand_assets_status_idx').on(t.farmId, t.status),
    index('brand_assets_processing_lease_idx').on(t.status, t.processingLeaseExpiresAt),
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
    uniqueIndex('brand_packs_farm_id_uq').on(t.farmId, t.id),
    index('brand_packs_farm_idx').on(t.farmId),
  ],
)

export const brandPackAssets = pgTable(
  'brand_pack_assets',
  {
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
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
    foreignKey({
      name: 'brand_pack_assets_pack_farm_fk',
      columns: [t.farmId, t.packId],
      foreignColumns: [brandPacks.farmId, brandPacks.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'brand_pack_assets_asset_farm_fk',
      columns: [t.farmId, t.assetId],
      foreignColumns: [brandAssets.farmId, brandAssets.id],
    }).onDelete('cascade'),
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
    uniqueIndex('journal_posts_farm_id_uq').on(t.farmId, t.id),
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

/**
 * Anonymous Journal reactions use a browser-generated, high-entropy token.
 * Only its SHA-256 hash is stored so a database export cannot be used to track
 * a reader outside Trovara. The composite foreign key prevents cross-farm
 * engagement records even if a route regression supplies a mismatched farm.
 */
export const journalPostLikes = pgTable(
  'journal_post_likes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    postId: uuid('post_id')
      .references(() => journalPosts.id, { onDelete: 'cascade' })
      .notNull(),
    visitorHash: text('visitor_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('journal_post_likes_post_visitor_uq').on(t.postId, t.visitorHash),
    index('journal_post_likes_farm_post_idx').on(t.farmId, t.postId),
    foreignKey({
      name: 'journal_post_likes_post_farm_fk',
      columns: [t.farmId, t.postId],
      foreignColumns: [journalPosts.farmId, journalPosts.id],
    }).onDelete('cascade'),
  ],
)

export const journalComments = pgTable(
  'journal_comments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    postId: uuid('post_id')
      .references(() => journalPosts.id, { onDelete: 'cascade' })
      .notNull(),
    visitorHash: text('visitor_hash').notNull(),
    authorName: text('author_name').notNull(),
    body: text('body').notNull(),
    status: text('status').default('pending').notNull(),
    moderatedById: uuid('moderated_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    moderatedAt: timestamp('moderated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('journal_comments_farm_post_status_idx').on(t.farmId, t.postId, t.status),
    index('journal_comments_farm_created_idx').on(t.farmId, t.createdAt),
    check(
      'journal_comments_status_check',
      sql`${t.status} in ('pending', 'approved', 'rejected')`,
    ),
    check('journal_comments_author_name_length', sql`char_length(${t.authorName}) between 1 and 80`),
    check('journal_comments_body_length', sql`char_length(${t.body}) between 2 and 1200`),
    foreignKey({
      name: 'journal_comments_post_farm_fk',
      columns: [t.farmId, t.postId],
      foreignColumns: [journalPosts.farmId, journalPosts.id],
    }).onDelete('cascade'),
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

export const newsletterCampaigns = pgTable(
  'newsletter_campaigns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'restrict' }).notNull(),
    campaignType: text('campaign_type').notNull(),
    audienceType: text('audience_type').notNull(),
    productKey: text('product_key'),
    journalPostId: uuid('journal_post_id').references(() => journalPosts.id, { onDelete: 'set null' }),
    subject: text('subject').notNull(),
    previewText: text('preview_text'),
    bodyText: text('body_text').notNull(),
    ctaLabel: text('cta_label'),
    ctaUrl: text('cta_url'),
    status: text('status').default('draft').notNull(),
    providerBroadcastId: text('provider_broadcast_id'),
    providerStatus: text('provider_status'),
    recipientCount: integer('recipient_count').default(0).notNull(),
    deliveredCount: integer('delivered_count').default(0).notNull(),
    failedCount: integer('failed_count').default(0).notNull(),
    lastError: text('last_error'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('newsletter_campaigns_farm_created_idx').on(t.farmId, t.createdAt),
    uniqueIndex('newsletter_campaigns_journal_once_uq')
      .on(t.farmId, t.journalPostId)
      .where(sql`${t.journalPostId} is not null`),
    uniqueIndex('newsletter_campaigns_provider_broadcast_uq')
      .on(t.providerBroadcastId)
      .where(sql`${t.providerBroadcastId} is not null`),
    check('newsletter_campaigns_type_check', sql`${t.campaignType} in ('journal', 'marketing', 'product_availability')`),
    check('newsletter_campaigns_audience_check', sql`${t.audienceType} in ('newsletter', 'product_waitlist')`),
    check('newsletter_campaigns_status_check', sql`${t.status} in ('draft', 'sending', 'sent', 'partial', 'failed')`),
    check('newsletter_campaigns_product_shape', sql`(${t.audienceType} = 'product_waitlist') = (${t.productKey} is not null)`),
    // Keep a sent Journal campaign as audit history even if its source post is
    // later deleted. Non-Journal campaigns must never point at a Journal post.
    check('newsletter_campaigns_journal_shape', sql`${t.campaignType} = 'journal' or ${t.journalPostId} is null`),
    check('newsletter_campaigns_counts_check', sql`${t.recipientCount} >= 0 and ${t.deliveredCount} >= 0 and ${t.failedCount} >= 0`),
  ],
)

export const newsletterCampaignDeliveries = pgTable(
  'newsletter_campaign_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    campaignId: uuid('campaign_id').references(() => newsletterCampaigns.id, { onDelete: 'cascade' }).notNull(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'restrict' }).notNull(),
    newsletterSubscriberId: uuid('newsletter_subscriber_id').references(() => newsletterSubscribers.id, { onDelete: 'set null' }),
    marketingLeadId: uuid('marketing_lead_id').references(() => marketingLeads.id, { onDelete: 'set null' }),
    recipientEmail: text('recipient_email').notNull(),
    recipientName: text('recipient_name').notNull(),
    status: text('status').default('pending').notNull(),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('newsletter_campaign_deliveries_campaign_email_uq').on(t.campaignId, t.recipientEmail),
    index('newsletter_campaign_deliveries_farm_campaign_idx').on(t.farmId, t.campaignId),
    check('newsletter_campaign_deliveries_status_check', sql`${t.status} in ('pending', 'sent', 'delivered', 'delayed', 'failed')`),
    check('newsletter_campaign_deliveries_recipient_source_check', sql`not (${t.newsletterSubscriberId} is not null and ${t.marketingLeadId} is not null)`),
    check('newsletter_campaign_deliveries_email_normalized', sql`${t.recipientEmail} = lower(${t.recipientEmail})`),
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
    check(
      'marketing_leads_survey_followup_shape',
      sql`${t.leadType}::text <> 'survey_followup' or ((${t.email} is not null or ${t.phone} is not null) and ${t.subjectKey} is not null and ${t.subjectLabel} is not null)`,
    ),
    check('marketing_leads_submission_count_positive', sql`${t.submissionCount} >= 1`),
  ],
)

export const customerSurveyResponses = pgTable(
  'customer_survey_responses',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'restrict' }).notNull(),
    surveyKey: text('survey_key').notNull(),
    answers: jsonb('answers').$type<Record<string, unknown>>().notNull(),
    followUp: text('follow_up').notNull(),
    name: text('name'),
    email: text('email'),
    phone: text('phone'),
    normalizedContact: text('normalized_contact'),
    leadId: uuid('lead_id').references(() => marketingLeads.id, { onDelete: 'set null' }),
    source: text('source').notNull(),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    referrer: text('referrer'),
    referralCode: text('referral_code'),
    consentAt: timestamp('consent_at', { withTimezone: true }).notNull(),
    consentVersion: text('consent_version').notNull(),
    privacyNoticeUrl: text('privacy_notice_url').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('customer_survey_responses_farm_created_idx').on(t.farmId, t.createdAt),
    index('customer_survey_responses_farm_follow_up_idx').on(t.farmId, t.followUp),
    index('customer_survey_responses_farm_survey_idx').on(t.farmId, t.surveyKey),
    check('customer_survey_responses_follow_up_check', sql`${t.followUp} in ('yes', 'maybe', 'no')`),
    check(
      'customer_survey_responses_follow_up_contact',
      sql`${t.followUp} = 'no' or ${t.normalizedContact} is not null`,
    ),
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

export const rateLimitBuckets = pgTable('rate_limit_buckets', {
  rateKey: text('rate_key').primaryKey(),
  attemptCount: integer('attempt_count').default(0).notNull(),
  windowStartsAt: timestamp('window_starts_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const totpChallenges = pgTable(
  'totp_challenges',
  {
    challengeHash: text('challenge_hash').primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    failedAttempts: integer('failed_attempts').default(0).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('totp_challenges_user_expiry_idx').on(t.userId, t.expiresAt)],
)

export const totpRecoveryCodes = pgTable(
  'totp_recovery_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('totp_recovery_codes_user_code_uq').on(t.userId, t.codeHash)],
)

export const totpReplaySteps = pgTable(
  'totp_replay_steps',
  {
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    step: integer('step').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.step] })],
)

export const whatsappProcessedMessages = pgTable(
  'whatsapp_processed_messages',
  {
    phoneNumberId: text('phone_number_id').notNull(),
    messageId: text('message_id').notNull(),
    status: text('status').default('processing').notNull(),
    lastError: text('last_error'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.phoneNumberId, t.messageId] }),
    check(
      'whatsapp_processed_messages_status_check',
      sql`${t.status} in ('processing', 'processed', 'failed')`,
    ),
  ],
)

export const alertRuns = pgTable(
  'alert_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    jobType: text('job_type').notNull(),
    periodKey: text('period_key').notNull(),
    status: text('status').default('processing').notNull(),
    lastError: text('last_error'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('alert_runs_farm_job_period_uq').on(t.farmId, t.jobType, t.periodKey),
    check('alert_runs_status_check', sql`${t.status} in ('processing', 'completed', 'failed')`),
  ],
)

export const storageCleanupJobs = pgTable(
  'storage_cleanup_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    storageRoot: text('storage_root').notNull(),
    storageKey: text('storage_key').notNull(),
    status: text('status').default('pending').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('storage_cleanup_jobs_root_key_uq').on(t.storageRoot, t.storageKey),
    index('storage_cleanup_jobs_status_idx').on(t.status, t.createdAt),
  ],
)

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
  farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
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
    workDate: date('work_date'),
    submittedMinutes: integer('submitted_minutes'),
    approvalStatus: text('approval_status').default('approved').notNull(),
    approvedById: uuid('approved_by_id').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
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
    uniqueIndex('attendance_sessions_user_work_date_uq')
      .on(t.farmId, t.userId, t.workDate)
      .where(sql`${t.workDate} is not null`),
    check(
      'attendance_sessions_approval_status_check',
      sql`${t.approvalStatus} in ('pending', 'approved', 'rejected')`,
    ),
    check(
      'attendance_sessions_submitted_minutes_check',
      sql`${t.submittedMinutes} is null or (${t.submittedMinutes} >= 15 and ${t.submittedMinutes} <= 960)`,
    ),
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
    /** Optional manufacturer barcode or farm QR identifier. SKU remains canonical. */
    scanCode: text('scan_code'),
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
    uniqueIndex('inventory_items_farm_scan_code_uq')
      .on(t.farmId, t.scanCode)
      .where(sql`${t.scanCode} is not null`),
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

export const cropCycles = pgTable(
  'crop_cycles',
  {
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
    /** Number of planted stands in this cycle; independent of a plot's baseline plant count. */
    standCount: integer('stand_count'),
    /** Stable Finance cost-centre code (legacy free-text values remain readable). */
    costCentre: text('cost_centre'),
    /** Why the last lifecycle generation produced nothing. See livestockBatches. */
    agronomySkipReason: text('agronomy_skip_reason'),
    notes: text('notes'),
    sourceLocale: text('source_locale'),
    translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
    translationAttempts: integer('translation_attempts').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check('crop_cycles_stand_count_positive', sql`${t.standCount} IS NULL OR ${t.standCount} > 0`),
    index('crop_cycles_farm_cost_centre_idx').on(t.farmId, t.costCentre),
  ],
)

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

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    entityCode: text('entity_code').default('002').notNull(),
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
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
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
  },
  (t) => [
    index('orders_farm_entity_idx').on(t.farmId, t.entityCode),
    check('orders_entity_code_check', sql`${t.entityCode} in ('001', '002')`),
  ],
)

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

export const customerCreditInvitations = pgTable(
  'customer_credit_invitations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    surveyResponseId: uuid('survey_response_id').references(() => customerSurveyResponses.id, {
      onDelete: 'set null',
    }),
    marketingLeadId: uuid('marketing_lead_id').references(() => marketingLeads.id, {
      onDelete: 'set null',
    }),
    email: text('email').notNull(),
    normalizedEmail: text('normalized_email').notNull(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedByAccountId: uuid('claimed_by_account_id').references(() => customerAccounts.id, {
      onDelete: 'set null',
    }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('customer_credit_invitations_farm_email_uq').on(t.farmId, t.normalizedEmail),
    index('customer_credit_invitations_farm_status_idx').on(t.farmId, t.claimedAt, t.sentAt),
  ],
)

export const customerReferralCodes = pgTable(
  'customer_referral_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    accountId: uuid('account_id').references(() => customerAccounts.id, { onDelete: 'cascade' }).notNull(),
    code: text('code').notNull().unique(),
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('customer_referral_codes_account_uq').on(t.accountId),
    index('customer_referral_codes_farm_idx').on(t.farmId, t.active),
  ],
)

export const customerCreditLedger = pgTable(
  'customer_credit_ledger',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    accountId: uuid('account_id').references(() => customerAccounts.id, { onDelete: 'cascade' }).notNull(),
    amount: integer('amount').notNull(),
    eventType: text('event_type').notNull(),
    sourceId: text('source_id').notNull(),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('customer_credit_ledger_event_source_uq').on(t.accountId, t.eventType, t.sourceId),
    uniqueIndex('customer_credit_ledger_welcome_uq')
      .on(t.accountId)
      .where(sql`${t.eventType} = 'welcome'`),
    index('customer_credit_ledger_account_created_idx').on(t.accountId, t.createdAt),
    check('customer_credit_ledger_amount_nonzero', sql`${t.amount} <> 0`),
    check(
      'customer_credit_ledger_event_type_check',
      sql`${t.eventType} in ('welcome', 'survey_referral', 'adjustment', 'redemption')`,
    ),
  ],
)

export const customerReferralAttributions = pgTable(
  'customer_referral_attributions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    referralCodeId: uuid('referral_code_id').references(() => customerReferralCodes.id, {
      onDelete: 'restrict',
    }).notNull(),
    referrerAccountId: uuid('referrer_account_id').references(() => customerAccounts.id, {
      onDelete: 'cascade',
    }).notNull(),
    surveyResponseId: uuid('survey_response_id').references(() => customerSurveyResponses.id, {
      onDelete: 'cascade',
    }).notNull(),
    referredNormalizedContact: text('referred_normalized_contact').notNull(),
    referredAccountId: uuid('referred_account_id').references(() => customerAccounts.id, {
      onDelete: 'set null',
    }),
    qualifyingOrderId: uuid('qualifying_order_id').references(() => orders.id, {
      onDelete: 'set null',
    }),
    rewardEligibleAt: timestamp('reward_eligible_at', { withTimezone: true }),
    creditedAt: timestamp('credited_at', { withTimezone: true }),
    ledgerEntryId: uuid('ledger_entry_id').references(() => customerCreditLedger.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('customer_referral_attributions_survey_uq').on(t.surveyResponseId),
    uniqueIndex('customer_referral_attributions_contact_uq').on(t.farmId, t.referredNormalizedContact),
    index('customer_referral_attributions_referrer_idx').on(t.referrerAccountId, t.createdAt),
    index('customer_referral_attributions_referred_account_idx').on(t.referredAccountId, t.createdAt),
    index('customer_referral_attributions_reward_due_idx').on(t.rewardEligibleAt, t.ledgerEntryId),
  ],
)

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
    entityCode: text('entity_code').default('002').notNull(),
    orderId: uuid('order_id').references(() => orders.id).notNull(),
    provider: text('provider').default('paystack').notNull(),
    providerReference: text('provider_reference').notNull().unique(),
    accessCode: text('access_code'),
    amountKobo: integer('amount_kobo').notNull(),
    currency: text('currency').default('NGN').notNull(),
    // initializing | initiated | initialization_unknown | success | failed | abandoned
    status: text('status').default('initiated').notNull(),
    providerEventId: text('provider_event_id'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('payment_attempts_order_id_idx').on(t.orderId),
    index('payment_attempts_farm_entity_idx').on(t.farmId, t.entityCode),
    uniqueIndex('payment_attempts_provider_event_uq')
      .on(t.providerEventId)
      .where(sql`${t.providerEventId} is not null`),
    check(
      'payment_attempts_status_check',
      sql`${t.status} in ('initializing', 'initiated', 'initialization_unknown', 'success', 'failed', 'abandoned')`,
    ),
    check('payment_attempts_entity_code_check', sql`${t.entityCode} in ('001', '002')`),
  ],
)

// Immutable invoice snapshot for an order (printable / public link).
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    entityCode: text('entity_code').default('002').notNull(),
    orderId: uuid('order_id').references(() => orders.id).notNull(),
    invoiceNumber: text('invoice_number').notNull(),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    currency: text('currency').default('NGN').notNull(),
    amountKobo: integer('amount_kobo').notNull(),
    publicToken: text('public_token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('invoices_order_id_uq').on(t.orderId),
    uniqueIndex('invoices_farm_number_uq').on(t.farmId, t.invoiceNumber),
    index('invoices_farm_entity_idx').on(t.farmId, t.entityCode),
    check('invoices_entity_code_check', sql`${t.entityCode} in ('001', '002')`),
  ],
)

// One receipt per successful payment attempt, linked to its invoice.
export const paymentReceipts = pgTable(
  'payment_receipts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    invoiceId: uuid('invoice_id').references(() => invoices.id).notNull(),
    paymentAttemptId: uuid('payment_attempt_id').references(() => paymentAttempts.id).notNull(),
    receiptNumber: text('receipt_number').notNull(),
    amountKobo: integer('amount_kobo').notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull(),
    publicToken: text('public_token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('payment_receipts_attempt_uq').on(t.paymentAttemptId),
    uniqueIndex('payment_receipts_farm_number_uq').on(t.farmId, t.receiptNumber),
  ],
)

export const paymentRefunds = pgTable(
  'payment_refunds',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    entityCode: text('entity_code').default('002').notNull(),
    paymentAttemptId: uuid('payment_attempt_id').references(() => paymentAttempts.id).notNull(),
    orderId: uuid('order_id').references(() => orders.id).notNull(),
    amountKobo: integer('amount_kobo').notNull(),
    providerRefundId: text('provider_refund_id'),
    // pending | submitting | unknown | success | failed
    status: text('status').default('pending').notNull(),
    reason: text('reason'),
    idempotencyKey: text('idempotency_key'),
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    sourceLocale: text('source_locale'),
    translationStatus: translationStatusEnum('translation_status').default('done').notNull(),
    translationAttempts: integer('translation_attempts').default(0).notNull(),
    createdById: uuid('created_by_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('payment_refunds_order_id_idx').on(t.orderId),
    index('payment_refunds_farm_entity_idx').on(t.farmId, t.entityCode),
    uniqueIndex('payment_refunds_idempotency_uq').on(t.paymentAttemptId, t.idempotencyKey),
    uniqueIndex('payment_refunds_provider_id_uq')
      .on(t.providerRefundId)
      .where(sql`${t.providerRefundId} is not null`),
    check(
      'payment_refunds_status_check',
      sql`${t.status} in ('pending', 'submitting', 'unknown', 'success', 'failed')`,
    ),
    check('payment_refunds_entity_code_check', sql`${t.entityCode} in ('001', '002')`),
  ],
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

// Persistent, private Copilot threads for authenticated OS users. Threads and
// messages are always queried by farm + user; there is intentionally no shared
// farm-wide chat history because prompts may contain customer or finance data.
export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    title: text('title').default('New conversation').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('ai_conversations_user_updated_idx').on(t.farmId, t.userId, t.updatedAt),
  ],
)

export const aiMessages = pgTable(
  'ai_messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .references(() => aiConversations.id, { onDelete: 'cascade' })
      .notNull(),
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    attachmentUrl: text('attachment_url'),
    model: text('model'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    feedbackRating: text('feedback_rating'),
    feedbackNote: text('feedback_note'),
    feedbackAt: timestamp('feedback_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('ai_messages_conversation_created_idx').on(t.conversationId, t.createdAt),
    index('ai_messages_farm_feedback_idx').on(t.farmId, t.feedbackRating, t.feedbackAt),
    check('ai_messages_role_check', sql`${t.role} in ('user', 'assistant')`),
    check(
      'ai_messages_feedback_rating_check',
      sql`${t.feedbackRating} is null or ${t.feedbackRating} in ('up', 'down')`,
    ),
  ],
)

// Register of equipment/tools/PPE the farm owns. Founders + supervisors define
// entries; daily state is tracked in asset_logs. Pool model: one row per item
// type with a quantity_owned; assigned_to_id optionally ties PPE to a worker.
export const contractors = pgTable(
  'contractors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    name: text('name').notNull(),
    company: text('company'),
    specialty: text('specialty').notNull(),
    phone: text('phone'),
    email: text('email'),
    status: text('status').default('active').notNull(),
    insuranceExpiresAt: timestamp('insurance_expires_at', { withTimezone: true }),
    notes: text('notes'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('contractors_farm_status_idx').on(t.farmId, t.status),
    check('contractors_status_check', sql`${t.status} in ('active', 'inactive', 'blocked')`),
  ],
)

export const contractorEngagements = pgTable(
  'contractor_engagements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    contractorId: uuid('contractor_id')
      .references(() => contractors.id, { onDelete: 'cascade' })
      .notNull(),
    title: text('title').notNull(),
    deliverables: text('deliverables'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'),
    rateType: text('rate_type').default('fixed').notNull(),
    agreedAmountMinor: integer('agreed_amount_minor').default(0).notNull(),
    paidAmountMinor: integer('paid_amount_minor').default(0).notNull(),
    currency: text('currency').default('NGN').notNull(),
    costCentreCode: text('cost_centre_code'),
    status: text('status').default('planned').notNull(),
    approvedById: uuid('approved_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('contractor_engagements_farm_status_idx').on(t.farmId, t.status),
    index('contractor_engagements_contractor_idx').on(t.contractorId, t.startDate),
    check(
      'contractor_engagements_status_check',
      sql`${t.status} in ('planned', 'active', 'completed', 'cancelled')`,
    ),
    check(
      'contractor_engagements_rate_type_check',
      sql`${t.rateType} in ('fixed', 'daily', 'hourly')`,
    ),
    check(
      'contractor_engagements_amounts_check',
      sql`${t.agreedAmountMinor} >= 0 and ${t.paidAmountMinor} >= 0 and ${t.paidAmountMinor} <= ${t.agreedAmountMinor}`,
    ),
  ],
)

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
  /** Optional manufacturer barcode or farm QR identifier. Asset tag remains human-facing. */
  scanCode: text('scan_code'),
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
}, (t) => [
  uniqueIndex('assets_farm_scan_code_uq')
    .on(t.farmId, t.scanCode)
    .where(sql`${t.scanCode} is not null`),
])

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

export const maintenanceWorkOrders = pgTable(
  'maintenance_work_orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'cascade' }).notNull(),
    contractorId: uuid('contractor_id').references(() => contractors.id, { onDelete: 'set null' }),
    assignedToId: uuid('assigned_to_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    serviceType: text('service_type').default('preventive').notNull(),
    priority: text('priority').default('normal').notNull(),
    status: text('status').default('open').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    meterReading: integer('meter_reading'),
    checklist: jsonb('checklist').$type<string[]>().default([]).notNull(),
    completedChecklist: jsonb('completed_checklist').$type<string[]>().default([]).notNull(),
    completionNotes: text('completion_notes'),
    partsUsed: text('parts_used'),
    estimatedCostMinor: integer('estimated_cost_minor'),
    actualCostMinor: integer('actual_cost_minor'),
    downtimeMinutes: integer('downtime_minutes'),
    evidenceUrl: text('evidence_url'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    completedById: uuid('completed_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('maintenance_work_orders_farm_status_due_idx').on(t.farmId, t.status, t.dueAt),
    index('maintenance_work_orders_asset_idx').on(t.assetId, t.createdAt),
    check(
      'maintenance_work_orders_status_check',
      sql`${t.status} in ('open', 'in_progress', 'completed', 'cancelled')`,
    ),
    check(
      'maintenance_work_orders_priority_check',
      sql`${t.priority} in ('low', 'normal', 'high', 'urgent')`,
    ),
    check(
      'maintenance_work_orders_service_type_check',
      sql`${t.serviceType} in ('preventive', 'inspection', 'repair', 'replacement')`,
    ),
  ],
)

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

export const expenses = pgTable(
  'expenses',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    entityCode: text('entity_code').default('002').notNull(),
    costCentreCode: text('cost_centre_code'),
    category: expenseCategoryEnum('category').notNull(),
    description: text('description').notNull(),
    amount: integer('amount').notNull(),
    currency: text('currency').default('NGN').notNull(),
    originalAmount: numeric('original_amount', { precision: 18, scale: 2 }),
    originalCurrency: text('original_currency'),
    fxRate: numeric('fx_rate', { precision: 18, scale: 6 }),
    fxConvertedAt: timestamp('fx_converted_at', { withTimezone: true }),
    fxRateDate: date('fx_rate_date'),
    fxRateSource: text('fx_rate_source'),
    vendor: text('vendor'),
    receiptRef: text('receipt_ref'),
    source: text('source').default('manual').notNull(),
    importBatchId: uuid('import_batch_id'),
    importSourceFilename: text('import_source_filename'),
    importSourceSheet: text('import_source_sheet'),
    importSourceHash: text('import_source_hash'),
    importSourceRecordId: text('import_source_record_id'),
    importSourceRowHash: text('import_source_row_hash'),
    importRowNumber: integer('import_row_number'),
    importFingerprint: text('import_fingerprint'),
    importAmountDerived: boolean('import_amount_derived').default(false).notNull(),
    payer: text('payer'),
    fundingStatus: text('funding_status'),
    projectPhase: text('project_phase'),
    inboundMessageId: text('inbound_message_id'),
    /** Parsed From: address for inbound_email drafts (ack goes here on approve). */
    inboundSenderEmail: text('inbound_sender_email'),
    /** Display name from From: header when present. */
    inboundSenderName: text('inbound_sender_name'),
    /** When we emailed the sender that Finance approved/received their invoice. */
    inboundAckSentAt: timestamp('inbound_ack_sent_at', { withTimezone: true }),
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
  },
  (t) => [
    uniqueIndex('expenses_farm_id_uq').on(t.farmId, t.id),
    index('expenses_farm_entity_idx').on(t.farmId, t.entityCode),
    index('expenses_farm_cost_centre_idx').on(t.farmId, t.costCentreCode),
    index('expenses_farm_import_source_hash_idx').on(t.farmId, t.importSourceHash),
    uniqueIndex('expenses_farm_import_fingerprint_uq')
      .on(t.farmId, t.importFingerprint)
      .where(sql`${t.importFingerprint} is not null`),
    uniqueIndex('expenses_inbound_message_uq')
      .on(t.farmId, t.inboundMessageId)
      .where(sql`${t.inboundMessageId} is not null`),
    check('expenses_source_check', sql`${t.source} in ('manual', 'inbound_email', 'import')`),
    check('expenses_entity_code_check', sql`${t.entityCode} in ('001', '002')`),
    check(
      'expenses_cost_centre_check',
      sql`${t.costCentreCode} is null or ${t.costCentreCode} in ('CC01', 'CC10', 'CC20', 'CC30', 'CC40', 'CC50', 'CC60', 'CC70', 'CC80')`,
    ),
    check(
      'expenses_extraction_method_check',
      sql`${t.extractionMethod} is null or ${t.extractionMethod} in ('heuristic', 'pdf_text', 'llm_text', 'llm_vision', 'none')`,
    ),
    check(
      'expenses_extraction_status_check',
      sql`${t.extractionStatus} is null or ${t.extractionStatus} in ('success', 'failed')`,
    ),
    check(
      'expenses_fx_metadata_check',
      sql`(
        (${t.originalAmount} is null and ${t.originalCurrency} is null and ${t.fxRate} is null and ${t.fxConvertedAt} is null)
        or
        (
          ${t.originalAmount} is not null and ${t.originalAmount} >= 0
          and ${t.originalCurrency} is not null and ${t.originalCurrency} <> 'NGN'
          and (
            (${t.fxRate} is null and ${t.fxConvertedAt} is null and ${t.currency} = ${t.originalCurrency})
            or
            (${t.fxRate} is not null and ${t.fxRate} > 0 and ${t.fxConvertedAt} is not null and ${t.currency} = 'NGN')
          )
        )
      )`,
    ),
    check(
      'expenses_fx_provenance_check',
      sql`(
        (${t.fxRate} is null and ${t.fxRateDate} is null and ${t.fxRateSource} is null)
        or
        (${t.fxRate} is not null and ${t.fxRateDate} is not null and ${t.fxRateSource} is not null)
      )`,
    ),
  ],
)

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
  (t) => [
    uniqueIndex('expense_labels_farm_slug_uq').on(t.farmId, t.slug),
    uniqueIndex('expense_labels_farm_id_uq').on(t.farmId, t.id),
  ],
)

export const expenseLabelLinks = pgTable(
  'expense_label_links',
  {
    farmId: uuid('farm_id')
      .references(() => farms.id, { onDelete: 'cascade' })
      .notNull(),
    expenseId: uuid('expense_id')
      .references(() => expenses.id, { onDelete: 'cascade' })
      .notNull(),
    labelId: uuid('label_id')
      .references(() => expenseLabels.id, { onDelete: 'cascade' })
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.expenseId, t.labelId] }),
    foreignKey({
      name: 'expense_label_links_expense_farm_fk',
      columns: [t.farmId, t.expenseId],
      foreignColumns: [expenses.farmId, expenses.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'expense_label_links_label_farm_fk',
      columns: [t.farmId, t.labelId],
      foreignColumns: [expenseLabels.farmId, expenseLabels.id],
    }).onDelete('cascade'),
  ],
)

export const financeInboundEvents = pgTable(
  'finance_inbound_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    svixId: text('svix_id').notNull().unique(),
    resendEmailId: text('resend_email_id'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    expenseId: uuid('expense_id').references(() => expenses.id, { onDelete: 'set null' }),
    status: text('status').default('received').notNull(),
    detail: text('detail'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockExpiresAt: timestamp('lock_expires_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').default(0).notNull(),
    lastError: text('last_error'),
  },
  (t) => [
    index('finance_inbound_events_reclaim_idx').on(t.status, t.lockExpiresAt),
    check(
      'finance_inbound_events_status_check',
      sql`${t.status} in ('received', 'processing', 'processed', 'failed', 'duplicate', 'ignored')`,
    ),
  ],
)

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
    consentVersion: text('consent_version'),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    description: text('description'),
    groupLabel: text('group_label'),
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
    retentionExpiresAt: timestamp('retention_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('moment_submissions_farm_status_idx').on(t.farmId, t.status, t.createdAt),
    index('moment_submissions_retention_idx').on(t.status, t.retentionExpiresAt),
    check(
      'moment_submissions_status_check',
      sql`${t.status} in ('pending', 'approved', 'rejected')`,
    ),
    check('moment_submissions_media_kind_check', sql`${t.mediaKind} in ('image', 'video')`),
    check(
      'moment_submissions_duration_check',
      sql`${t.durationSeconds} is null or ${t.durationSeconds} >= 0`,
    ),
    check(
      'moment_submissions_consent_check',
      sql`${t.consent} = false or (${t.consentVersion} is not null and ${t.consentAt} is not null)`,
    ),
  ],
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
    engagementDetails: text('engagement_details'),
    projectName: text('project_name'),
    duration: text('duration'),
    applicationDeadline: date('application_deadline'),
    expectedStartDate: date('expected_start_date'),
    summary: text('summary').notNull(),
    bodyMarkdown: text('body_markdown').notNull(),
    applyEmail: text('apply_email').default('hello@trovara.farm').notNull(),
    applySubject: text('apply_subject'),
    applicationInstructions: text('application_instructions'),
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
      'career_posts_employment_type_check',
      sql`${t.employmentType} in ('full_time', 'part_time', 'contract', 'internship', 'temporary', 'consultancy', 'graduate_placement')`,
    ),
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

/**
 * Review-only signals produced by deterministic anomaly rules. These rows are
 * observations, not accusations or source-of-truth mutations. Human review
 * feedback is retained so thresholds can be calibrated without training the LLM.
 */
export const anomalyObservations = pgTable(
  'anomaly_observations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id, { onDelete: 'cascade' }).notNull(),
    fingerprint: text('fingerprint').notNull(),
    observationType: text('observation_type').notNull(),
    category: text('category').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    severity: text('severity').default('medium').notNull(),
    confidence: integer('confidence').default(50).notNull(),
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    sourceRule: text('source_rule').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().default({}).notNull(),
    status: text('status').default('observed').notNull(),
    reviewedById: uuid('reviewed_by_id').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),
    firstObservedAt: timestamp('first_observed_at', { withTimezone: true }).defaultNow().notNull(),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('anomaly_observations_farm_open_fingerprint_uq')
      .on(t.farmId, t.fingerprint)
      .where(sql`${t.status} = 'observed'`),
    index('anomaly_observations_farm_status_last_idx').on(t.farmId, t.status, t.lastObservedAt),
    check('anomaly_observations_category_check', sql`${t.category} in ('inventory', 'finance', 'maintenance')`),
    check('anomaly_observations_severity_check', sql`${t.severity} in ('low', 'medium', 'high')`),
    check('anomaly_observations_confidence_check', sql`${t.confidence} between 0 and 100`),
    check('anomaly_observations_status_check', sql`${t.status} in ('observed', 'explained', 'confirmed', 'false_positive')`),
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
