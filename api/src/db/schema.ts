import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  pgEnum,
  jsonb,
  boolean,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core'

export const userRoleEnum = pgEnum('user_role', ['owner', 'supervisor', 'field_worker'])
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
export const poultryBatchTypeEnum = pgEnum('poultry_batch_type', ['broiler', 'layer', 'pullet', 'other'])
export const purchaseOrderStatusEnum = pgEnum('purchase_order_status', [
  'draft',
  'approved',
  'sent',
  'partially_received',
  'received',
  'cancelled',
])

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
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('users_farm_employee_number_uq').on(t.farmId, t.employeeNumber),
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

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
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

export const inventoryItems = pgTable('inventory_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  unit: inventoryUnitEnum('unit').notNull(),
  quantity: integer('quantity').default(0).notNull(),
  reorderLevel: integer('reorder_level').default(10).notNull(),
  costPerUnit: integer('cost_per_unit'),
  supplier: text('supplier'),
  expiryDate: timestamp('expiry_date', { withTimezone: true }),
  storageLocation: text('storage_location'),
  batchNumber: text('batch_number'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
    itemId: uuid('item_id').references(() => inventoryItems.id).notNull(),
    delta: integer('delta').notNull(),
    reason: text('reason').notNull(),
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

export const cropCycles = pgTable('crop_cycles', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  plotId: uuid('plot_id').references(() => plots.id).notNull(),
  cropType: text('crop_type').notNull(),
  stage: cropStageEnum('stage').default('planted').notNull(),
  plantedAt: timestamp('planted_at', { withTimezone: true }).notNull(),
  expectedHarvestAt: timestamp('expected_harvest_at', { withTimezone: true }),
  actualHarvestAt: timestamp('actual_harvest_at', { withTimezone: true }),
  expectedYieldKg: integer('expected_yield_kg'),
  actualYieldKg: integer('actual_yield_kg'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

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
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const livestockLogs = pgTable('livestock_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  batchId: uuid('batch_id').references(() => livestockBatches.id).notNull(),
  logType: livestockLogTypeEnum('log_type').notNull(),
  headCount: integer('head_count'),
  notes: text('notes'),
  recordedById: uuid('recorded_by_id').references(() => users.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const harvestLots = pgTable('harvest_lots', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  lotCode: text('lot_code').notNull(),
  /** High-entropy token for public traceability URLs (not guessable like lotCode). */
  publicToken: text('public_token')
    .notNull()
    .$defaultFn(() => randomUUID()),
  plotId: uuid('plot_id').references(() => plots.id),
  cropCycleId: uuid('crop_cycle_id').references(() => cropCycles.id),
  productName: text('product_name').notNull(),
  quantityKg: integer('quantity_kg').notNull(),
  publicNotes: text('public_notes'),
  internalNotes: text('internal_notes'),
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
  totalAmount: integer('total_amount').default(0).notNull(),
  currency: text('currency').default('NGN').notNull(),
  lotId: uuid('lot_id').references(() => harvestLots.id),
  // Set when the order was placed by a customer via a chat bot; null for
  // staff-entered orders. `source` records the channel it came in on.
  customerContactId: uuid('customer_contact_id').references(() => customerContacts.id),
  source: text('source').default('staff').notNull(),
  notes: text('notes'),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// Sellable catalog shown by the customer order bot. Prices are in kobo (integer
// minor units); price_kobo = 0 means "price on request" until a Founder sets it.
export const products = pgTable('products', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  name: text('name').notNull(),
  unit: text('unit').default('unit').notNull(),
  priceKobo: integer('price_kobo').default(0).notNull(),
  currency: text('currency').default('NGN').notNull(),
  active: boolean('active').default(true).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// A buyer who reached the farm through a chat bot. Anonymous (no login / RBAC);
// the customer analogue of the staff telegram_link. Scoped per farm + channel.
export const customerContacts = pgTable(
  'customer_contacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    farmId: uuid('farm_id').references(() => farms.id).notNull(),
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
  photoUrl: text('photo_url'),
  recordedById: uuid('recorded_by_id').references(() => users.id).notNull(),
  // 'reported' | 'verified' | 'rejected'
  verificationStatus: text('verification_status').default('reported').notNull(),
  verifiedById: uuid('verified_by_id').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

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
  approvalStatus: text('approval_status').default('approved').notNull(),
  recordedById: uuid('recorded_by_id').references(() => users.id).notNull(),
  expenseDate: timestamp('expense_date', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

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
  recordedById: uuid('recorded_by_id').references(() => users.id).notNull(),
  verifiedById: uuid('verified_by_id').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
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
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const actionDrafts = pgTable('action_drafts', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  channel: text('channel').default('web').notNull(),
  externalChatId: text('external_chat_id'),
  actionType: text('action_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
  status: text('status').default('pending').notNull(),
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

export type UserRole = 'owner' | 'supervisor' | 'field_worker'
export type TaskStatus = 'pending' | 'in_progress' | 'awaiting_approval' | 'completed' | 'rejected'
