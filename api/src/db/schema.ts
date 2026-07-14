import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  pgEnum,
  jsonb,
  boolean,
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

export const farms = pgTable('farms', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  location: text('location').notNull(),
  liveMode: boolean('live_mode').default(false).notNull(),
  liveStartedAt: timestamp('live_started_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: userRoleEnum('role').notNull(),
  phone: text('phone'),
  dailyWageNgn: integer('daily_wage_ngn'),
  mustChangePassword: boolean('must_change_password').default(false).notNull(),
  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').default(false).notNull(),
  totpRecoveryCodes: jsonb('totp_recovery_codes'),
  butlerTtsMode: butlerTtsModeEnum('butler_tts_mode').default('voice_replies').notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

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

export const taskTemplates = pgTable('task_templates', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  cropType: text('crop_type'),
  checklist: jsonb('checklist').$type<string[]>(),
  defaultDurationHours: integer('default_duration_hours'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

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

export const plots = pgTable('plots', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  zoneId: uuid('zone_id'),
  name: text('name').notNull(),
  cropType: text('crop_type').notNull(),
  cropVariety: text('crop_variety'),
  areaAcres: text('area_acres'),
  plantCount: integer('plant_count'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const zones = pgTable('zones', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

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

export const inventoryMovements = pgTable('inventory_movements', {
  id: uuid('id').defaultRandom().primaryKey(),
  farmId: uuid('farm_id').references(() => farms.id).notNull(),
  itemId: uuid('item_id').references(() => inventoryItems.id).notNull(),
  delta: integer('delta').notNull(),
  reason: text('reason').notNull(),
  recordedById: uuid('recorded_by_id').references(() => users.id).notNull(),
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
  plotId: uuid('plot_id').references(() => plots.id),
  cropCycleId: uuid('crop_cycle_id').references(() => cropCycles.id),
  productName: text('product_name').notNull(),
  quantityKg: integer('quantity_kg').notNull(),
  publicNotes: text('public_notes'),
  internalNotes: text('internal_notes'),
  harvestedAt: timestamp('harvested_at', { withTimezone: true }).notNull(),
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
  notes: text('notes'),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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

export type UserRole = 'owner' | 'supervisor' | 'field_worker'
export type TaskStatus = 'pending' | 'in_progress' | 'awaiting_approval' | 'completed' | 'rejected'
