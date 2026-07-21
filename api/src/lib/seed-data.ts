import { randomBytes } from 'node:crypto'
import { hashPassword } from './session.js'
import { getBreakGlassEmail } from './registration.js'
import { slugify } from './slug.js'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  farms,
  users,
  plots,
  zones,
  plantingUnits,
  taskTemplates,
  recurringSchedules,
  farmEvents,
  tasks,
  inventoryItems,
  inventoryMovements,
  auditEvents,
  sessions,
  cropCycles,
  livestockBatches,
  livestockLogs,
  harvestLots,
  orders,
  orderItems,
  products,
  customerContacts,
  customerChatSessions,
  customerInquiries,
  assets,
  assetEvents,
  assetLogs,
  expenses,
  consentRecords,
  passwordResetTokens,
  taskInventoryUsage,
  actionDrafts,
  attendanceSessions,
  suppliers,
  purchaseOrders,
  purchaseOrderLines,
  goodsReceipts,
  goodsReceiptLines,
  cropCensusSurveys,
  cropCensusEvidence,
  inventoryCountSessions,
  inventoryCountLines,
  weatherCache,
  telegramProcessedUpdates,
} from '../db/schema.js'

async function deleteFarmScopedData(farmId: string): Promise<void> {
  const farmUsers = await db.select({ id: users.id }).from(users).where(eq(users.farmId, farmId))
  const userIds = farmUsers.map((u) => u.id)

  if (userIds.length > 0) {
    await db.delete(sessions).where(inArray(sessions.userId, userIds))
    await db.delete(passwordResetTokens).where(inArray(passwordResetTokens.userId, userIds))
  }

  await db.delete(actionDrafts).where(eq(actionDrafts.farmId, farmId))
  await db.delete(attendanceSessions).where(eq(attendanceSessions.farmId, farmId))
  await db
    .delete(cropCensusEvidence)
    .where(
      inArray(
        cropCensusEvidence.surveyId,
        db.select({ id: cropCensusSurveys.id }).from(cropCensusSurveys).where(eq(cropCensusSurveys.farmId, farmId)),
      ),
    )
  await db.delete(cropCensusSurveys).where(eq(cropCensusSurveys.farmId, farmId))
  await db
    .delete(inventoryCountLines)
    .where(
      inArray(
        inventoryCountLines.sessionId,
        db
          .select({ id: inventoryCountSessions.id })
          .from(inventoryCountSessions)
          .where(eq(inventoryCountSessions.farmId, farmId)),
      ),
    )
  await db.delete(inventoryCountSessions).where(eq(inventoryCountSessions.farmId, farmId))
  await db
    .delete(goodsReceiptLines)
    .where(
      inArray(
        goodsReceiptLines.goodsReceiptId,
        db.select({ id: goodsReceipts.id }).from(goodsReceipts).where(eq(goodsReceipts.farmId, farmId)),
      ),
    )
  await db.delete(goodsReceipts).where(eq(goodsReceipts.farmId, farmId))
  await db
    .delete(purchaseOrderLines)
    .where(
      inArray(
        purchaseOrderLines.purchaseOrderId,
        db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.farmId, farmId)),
      ),
    )
  await db.delete(purchaseOrders).where(eq(purchaseOrders.farmId, farmId))
  await db.delete(suppliers).where(eq(suppliers.farmId, farmId))

  await db
    .delete(orderItems)
    .where(
      inArray(
        orderItems.orderId,
        db.select({ id: orders.id }).from(orders).where(eq(orders.farmId, farmId)),
      ),
    )
  await db.delete(orders).where(eq(orders.farmId, farmId))
  await db.delete(assetEvents).where(eq(assetEvents.farmId, farmId))
  await db.delete(assetLogs).where(eq(assetLogs.farmId, farmId))
  await db.delete(assets).where(eq(assets.farmId, farmId))
  await db.delete(customerInquiries).where(eq(customerInquiries.farmId, farmId))
  await db.delete(customerChatSessions).where(eq(customerChatSessions.farmId, farmId))
  await db.delete(customerContacts).where(eq(customerContacts.farmId, farmId))
  await db.delete(products).where(eq(products.farmId, farmId))
  await db.delete(expenses).where(eq(expenses.farmId, farmId))
  await db.delete(harvestLots).where(eq(harvestLots.farmId, farmId))
  await db.delete(livestockLogs).where(eq(livestockLogs.farmId, farmId))
  await db.delete(farmEvents).where(eq(farmEvents.farmId, farmId))
  await db.delete(livestockBatches).where(eq(livestockBatches.farmId, farmId))
  await db.delete(cropCycles).where(eq(cropCycles.farmId, farmId))
  await db.delete(auditEvents).where(eq(auditEvents.farmId, farmId))
  await db.delete(taskInventoryUsage).where(eq(taskInventoryUsage.farmId, farmId))
  await db.delete(inventoryMovements).where(eq(inventoryMovements.farmId, farmId))
  await db.delete(tasks).where(eq(tasks.farmId, farmId))
  await db.delete(recurringSchedules).where(eq(recurringSchedules.farmId, farmId))
  await db.delete(taskTemplates).where(eq(taskTemplates.farmId, farmId))
  await db.delete(plantingUnits).where(eq(plantingUnits.farmId, farmId))
  await db.delete(inventoryItems).where(eq(inventoryItems.farmId, farmId))
  await db.delete(plots).where(eq(plots.farmId, farmId))
  await db.delete(zones).where(eq(zones.farmId, farmId))
  await db.delete(consentRecords).where(eq(consentRecords.farmId, farmId))
  await db.delete(weatherCache).where(eq(weatherCache.farmId, farmId))
  await db
    .update(users)
    .set({ monthlyWageConfirmedById: null })
    .where(eq(users.farmId, farmId))
  await db.delete(users).where(eq(users.farmId, farmId))
}

async function deleteAllData(): Promise<void> {
  await db.delete(actionDrafts)
  await db.delete(attendanceSessions)
  await db.delete(cropCensusEvidence)
  await db.delete(cropCensusSurveys)
  await db.delete(inventoryCountLines)
  await db.delete(inventoryCountSessions)
  await db.delete(goodsReceiptLines)
  await db.delete(goodsReceipts)
  await db.delete(purchaseOrderLines)
  await db.delete(purchaseOrders)
  await db.delete(suppliers)
  await db.delete(orderItems)
  await db.delete(orders)
  await db.delete(assetEvents)
  await db.delete(assetLogs)
  await db.delete(assets)
  await db.delete(customerInquiries)
  await db.delete(customerChatSessions)
  await db.delete(customerContacts)
  await db.delete(products)
  await db.delete(expenses)
  await db.delete(harvestLots)
  await db.delete(livestockLogs)
  await db.delete(farmEvents)
  await db.delete(livestockBatches)
  await db.delete(cropCycles)
  await db.delete(auditEvents)
  await db.delete(taskInventoryUsage)
  await db.delete(inventoryMovements)
  await db.delete(tasks)
  await db.delete(recurringSchedules)
  await db.delete(taskTemplates)
  await db.delete(plantingUnits)
  await db.delete(inventoryItems)
  await db.delete(plots)
  await db.delete(zones)
  await db.delete(consentRecords)
  await db.delete(sessions)
  await db.delete(passwordResetTokens)
  await db.delete(weatherCache)
  await db.delete(telegramProcessedUpdates)
  await db.update(users).set({ monthlyWageConfirmedById: null })
  await db.delete(users)
  await db.delete(farms)
}

async function insertDemoContentForFarm(farmId: string): Promise<void> {
  const breakGlassPassword = process.env.BREAK_GLASS_PASSWORD
  const supervisorPassword = process.env.SEED_SUPERVISOR_PASSWORD
  const workerPassword = process.env.SEED_WORKER_PASSWORD
  const salesPassword = process.env.SEED_SALES_PASSWORD

  if (!breakGlassPassword || !supervisorPassword || !workerPassword || !salesPassword) {
    throw new Error(
      'Set BREAK_GLASS_PASSWORD, SEED_SUPERVISOR_PASSWORD, SEED_WORKER_PASSWORD in .env',
    )
  }

  // Break-glass owner authenticates via BREAK_GLASS_PASSWORD in env at login time.
  // Store a random unusable hash so the real secret is never the DB password.
  const breakGlassPlaceholderHash = await hashPassword(randomBytes(32).toString('base64url'))

  const [owner, sup1, sup2, worker1, worker2, sales] = await db
    .insert(users)
    .values([
      {
        farmId,
        email: getBreakGlassEmail(),
        name: 'Farm Admin',
        phone: '2348100000000',
        passwordHash: breakGlassPlaceholderHash,
        role: 'owner',
        mustChangePassword: false,
      },
      {
        farmId: farmId,
        email: 'supervisor1@trovara.farm',
        name: 'Ade Supervisor',
        phone: '2348100000001',
        passwordHash: await hashPassword(supervisorPassword),
        role: 'supervisor',
        monthlyWageNgn: 176000,
        mustChangePassword: true,
      },
      {
        farmId: farmId,
        email: 'supervisor2@trovara.farm',
        name: 'Bola Manager',
        phone: '2348100000003',
        passwordHash: await hashPassword(supervisorPassword),
        role: 'supervisor',
        monthlyWageNgn: 176000,
        mustChangePassword: true,
      },
      {
        farmId: farmId,
        email: 'worker1@trovara.farm',
        name: 'Tunde Field',
        phone: '2348103693426',
        passwordHash: await hashPassword(workerPassword),
        role: 'field_worker',
        monthlyWageNgn: 110000,
        monthlyWageEffectiveFrom: '2026-01-01',
        nextOfKinName: 'Funke Field',
        nextOfKinPhone: '2348100000101',
        nextOfKinRelationship: 'spouse',
        employeeNumber: 'W-001',
        jobTitle: 'Field hand',
        employmentType: 'permanent',
        employmentStartDate: '2025-06-01',
        employmentStatus: 'employed',
        mustChangePassword: true,
      },
      {
        farmId: farmId,
        email: 'worker2@trovara.farm',
        name: 'Yemi Field',
        phone: '2348100000002',
        passwordHash: await hashPassword(workerPassword),
        role: 'field_worker',
        monthlyWageNgn: 110000,
        monthlyWageEffectiveFrom: '2026-01-01',
        nextOfKinName: 'Kemi Field',
        nextOfKinPhone: '2348100000102',
        nextOfKinRelationship: 'sibling',
        employeeNumber: 'W-002',
        jobTitle: 'Field hand',
        employmentType: 'casual',
        employmentStartDate: '2025-09-01',
        employmentStatus: 'employed',
        mustChangePassword: true,
      },
      {
        farmId: farmId,
        email: 'sales@trovara.farm',
        name: 'Yemi Sales',
        phone: '2348100000004',
        passwordHash: await hashPassword(salesPassword),
        role: 'sales',
        monthlyWageNgn: 110000,
        monthlyWageEffectiveFrom: '2026-01-01',
        nextOfKinName: 'Kemi Sales',
        nextOfKinPhone: '2348100000104',
        nextOfKinRelationship: 'sibling',
        employeeNumber: 'S-001',
        jobTitle: 'Sales associate',
        employmentType: 'permanent',
        employmentStartDate: '2025-09-01',
        employmentStatus: 'employed',
        mustChangePassword: true,
      },
    ])
    .returning()

  const zoneRows = await db
    .insert(zones)
    .values([
      { farmId: farmId, name: 'North Orchard', description: 'Coconut and plantain blocks' },
      { farmId: farmId, name: 'South Poultry', description: 'Broiler production zone' },
    ])
    .returning()

  const [northZone, southZone] = zoneRows

  const plotRows = await db
    .insert(plots)
    .values([
      {
        farmId: farmId,
        zoneId: northZone.id,
        name: 'Coconut Block A',
        cropType: 'coconut',
        areaAcres: '12',
        plantCount: 480,
      },
      {
        farmId: farmId,
        zoneId: northZone.id,
        name: 'Plantain Block B',
        cropType: 'plantain',
        areaAcres: '8',
        plantCount: 320,
      },
      {
        farmId: farmId,
        zoneId: southZone.id,
        name: 'Poultry Zone C',
        cropType: 'poultry_prep',
        areaAcres: '3',
      },
    ])
    .returning()

  const [coconutPlot, plantainPlot, poultryPlot] = plotRows

  await db.insert(plantingUnits).values([
    {
      farmId: farmId,
      plotId: coconutPlot.id,
      label: 'Row A1',
      unitType: 'coconut_seedling',
      status: 'active',
      plantedAt: new Date(Date.now() - 180 * 86400000),
    },
    {
      farmId: farmId,
      plotId: plantainPlot.id,
      label: 'Sucker Block 3',
      unitType: 'plantain_sucker',
      status: 'active',
      plantedAt: new Date(Date.now() - 120 * 86400000),
    },
  ])

  const templateRows = await db
    .insert(taskTemplates)
    .values([
      {
        farmId: farmId,
        name: 'Plantain weeding',
        description: 'Clear weeds between plantain rows',
        cropType: 'plantain',
        checklist: ['Inspect row spacing', 'Remove weeds by hand', 'Mulch cleared areas'],
        defaultDurationHours: 4,
      },
      {
        farmId: farmId,
        name: 'Coconut irrigation',
        description: 'Scheduled irrigation for coconut block',
        cropType: 'coconut',
        checklist: ['Check drip lines', 'Run irrigation cycle', 'Log water usage'],
        defaultDurationHours: 2,
      },
      {
        farmId: farmId,
        name: 'Broiler feeding',
        description: 'Morning and evening feed rounds',
        cropType: 'poultry',
        checklist: ['Check feeder levels', 'Distribute feed evenly', 'Record feed bags used'],
        defaultDurationHours: 1,
      },
    ])
    .returning()

  const [weedingTemplate, irrigationTemplate, feedingTemplate] = templateRows

  await db.insert(recurringSchedules).values([
    {
      farmId: farmId,
      templateId: weedingTemplate.id,
      recurrence: 'weekly',
      assignedToId: worker2.id,
      plotId: plantainPlot.id,
      active: true,
      nextRunAt: new Date(Date.now() - 86400000),
    },
    {
      farmId: farmId,
      templateId: irrigationTemplate.id,
      recurrence: 'daily',
      assignedToId: worker1.id,
      plotId: coconutPlot.id,
      active: true,
      nextRunAt: new Date(Date.now() - 3600000),
    },
    {
      farmId: farmId,
      templateId: feedingTemplate.id,
      recurrence: 'daily',
      assignedToId: worker1.id,
      plotId: poultryPlot.id,
      active: true,
      nextRunAt: new Date(Date.now() + 86400000),
    },
  ])

  await db.insert(tasks).values([
    {
      farmId: farmId,
      plotId: coconutPlot.id,
      title: 'Irrigate coconut seedlings',
      description: 'Morning irrigation for Block A',
      templateId: irrigationTemplate.id,
      status: 'in_progress',
      assignedToId: worker1.id,
      createdById: sup1.id,
      dueDate: new Date(Date.now() + 86400000),
    },
    {
      farmId: farmId,
      plotId: plantainPlot.id,
      title: 'Weed plantain rows',
      description: 'Clear weeds between rows in Block B',
      templateId: weedingTemplate.id,
      status: 'pending',
      assignedToId: worker2.id,
      createdById: sup1.id,
      dueDate: new Date(Date.now() + 2 * 86400000),
    },
    {
      farmId: farmId,
      plotId: poultryPlot.id,
      title: 'Prepare poultry shed flooring',
      description: 'Level and disinfect before batch arrival',
      status: 'awaiting_approval',
      assignedToId: worker1.id,
      createdById: sup2.id,
      completionNote: 'Flooring leveled and disinfected',
      dueDate: new Date(),
    },
    {
      farmId: farmId,
      plotId: coconutPlot.id,
      title: 'Apply organic fertilizer',
      status: 'completed',
      assignedToId: worker2.id,
      createdById: owner.id,
      approvedById: sup1.id,
      completedAt: new Date(Date.now() - 86400000),
    },
    {
      farmId: farmId,
      title: 'Weekly inventory count',
      status: 'pending',
      assignedToId: sup2.id,
      createdById: owner.id,
    },
    {
      farmId: farmId,
      plotId: plantainPlot.id,
      title: 'Inspect for pests',
      status: 'in_progress',
      assignedToId: worker1.id,
      createdById: sup2.id,
    },
    {
      farmId: farmId,
      plotId: poultryPlot.id,
      title: 'Install water lines',
      status: 'pending',
      assignedToId: worker2.id,
      createdById: sup2.id,
    },
    {
      farmId: farmId,
      title: 'Review supplier quotes for feed',
      status: 'pending',
      assignedToId: sup1.id,
      createdById: owner.id,
    },
  ])

  const invRows = await db
    .insert(inventoryItems)
    .values([
      { farmId: farmId, name: 'Poultry Feed', category: 'feed', unit: 'bags', quantity: 45, reorderLevel: 20 },
      { farmId: farmId, name: 'Organic Fertilizer', category: 'inputs', unit: 'bags', quantity: 3, reorderLevel: 15 },
      { farmId: farmId, name: 'Coconut Seedlings', category: 'planting', unit: 'units', quantity: 120, reorderLevel: 30 },
      { farmId: farmId, name: 'Packaging Crates', category: 'packaging', unit: 'crates', quantity: 25, reorderLevel: 10 },
      { farmId: farmId, name: 'Diesel (generator)', category: 'fuel', unit: 'liters', quantity: 60, reorderLevel: 40 },
    ])
    .returning()

  const fertilizer = invRows.find((i) => i.name === 'Organic Fertilizer')!

  await db.insert(inventoryMovements).values({
    farmId: farmId,
    itemId: fertilizer.id,
    delta: -5,
    reason: 'Applied to coconut Block A',
    recordedById: sup1.id,
  })

  const now = Date.now()
  const [coconutCycle, plantainCycle] = await db
    .insert(cropCycles)
    .values([
      {
        farmId: farmId,
        plotId: coconutPlot.id,
        cropType: 'coconut',
        stage: 'vegetative',
        plantedAt: new Date(now - 180 * 86400000),
        expectedHarvestAt: new Date(now + 365 * 86400000),
        expectedYieldKg: 2400,
        notes: 'Year-one coconut seedlings - Block A',
      },
      {
        farmId: farmId,
        plotId: plantainPlot.id,
        cropType: 'plantain',
        stage: 'fruiting',
        plantedAt: new Date(now - 120 * 86400000),
        expectedHarvestAt: new Date(now + 60 * 86400000),
        expectedYieldKg: 1800,
        notes: 'Second ratoon - Block B',
      },
    ])
    .returning()

  await db.insert(livestockBatches).values({
    farmId: farmId,
    plotId: poultryPlot.id,
    name: 'Poultry Batch 2026-A',
    species: 'broiler',
    batchType: 'broiler',
    headCount: 500,
    startCount: 500,
    feedUsedKg: 850,
    acquiredAt: new Date(now - 14 * 86400000),
    targetCloseoutAt: new Date(now + 28 * 86400000),
    notes: 'Active broiler batch - shed stocked',
    active: true,
  })

  const [coconutLot, plantainLot] = await db
    .insert(harvestLots)
    .values([
      {
        farmId: farmId,
        lotCode: 'TRV-COC-2026-001',
        plotId: coconutPlot.id,
        cropCycleId: coconutCycle.id,
        productName: 'Young coconut (sample harvest)',
        quantityKg: 120,
        harvestedAt: new Date(now - 7 * 86400000),
      },
      {
        farmId: farmId,
        lotCode: 'TRV-PLT-2026-002',
        plotId: plantainPlot.id,
        cropCycleId: plantainCycle.id,
        productName: 'Plantain bunch',
        quantityKg: 85,
        harvestedAt: new Date(now - 3 * 86400000),
      },
      {
        farmId: farmId,
        lotCode: 'TRV-PLT-2026-003',
        plotId: plantainPlot.id,
        cropCycleId: plantainCycle.id,
        productName: 'Plantain bunch (field report)',
        quantityKg: 40,
        harvestedAt: new Date(now - 1 * 86400000),
        reportedById: worker1.id,
        verificationStatus: 'reported',
      },
    ])
    .returning()

  await db.insert(orders).values([
    {
      farmId: farmId,
      customerName: 'Abeokuta Fresh Market',
      customerPhone: '+2348012345678',
      status: 'pending',
      totalAmount: 45000,
      lotId: plantainLot.id,
      notes: 'Awaiting pickup confirmation',
    },
    {
      farmId: farmId,
      customerName: 'Lagos Wholesale Co.',
      customerPhone: '+2348098765432',
      status: 'delivered',
      totalAmount: 72000,
      lotId: coconutLot.id,
      notes: 'Delivered via refrigerated van',
      dispatchedAt: new Date(now - 5 * 86400000),
    },
  ])

  // Customer-bot catalog (Trovara Fresh *). Eggs have a default price; others
  // are "price on request" (0) until staff set them in Products.
  await db.insert(products).values([
    {
      farmId,
      name: 'Trovara Fresh Pasture-Raised Eggs',
      unit: 'crate',
      sortOrder: 1,
      priceKobo: 650000,
    },
    { farmId, name: 'Trovara Fresh Plantain', unit: 'bunch', sortOrder: 2, priceKobo: 0 },
    { farmId, name: 'Trovara Fresh Coconut', unit: 'piece', sortOrder: 3, priceKobo: 0 },
    { farmId, name: 'Trovara Fresh Chicken', unit: 'bird', sortOrder: 4, priceKobo: 0 },
    { farmId, name: 'Trovara Fresh Plantain Flour', unit: 'pack', sortOrder: 5, priceKobo: 0 },
    { farmId, name: 'Trovara Fresh Dried Plantain', unit: 'pack', sortOrder: 6, priceKobo: 0 },
  ])

  // Equipment/asset register (pool model). An Admin/supervisor maintains these;
  // workers log daily state and a supervisor verifies.
  const assetRows = await db
    .insert(assets)
    .values([
      { farmId, name: 'Rubber boots', category: 'ppe', unit: 'pair', quantityOwned: 8, createdById: owner.id },
      { farmId, name: 'Knapsack sprayer', category: 'tool', unit: 'unit', quantityOwned: 3, createdById: sup1.id },
      { farmId, name: 'Cutlass', category: 'tool', unit: 'unit', quantityOwned: 6, createdById: sup1.id },
      { farmId, name: 'Pickup truck', category: 'vehicle', unit: 'unit', quantityOwned: 1, createdById: owner.id },
    ])
    .returning()

  const bootsAsset = assetRows.find((a) => a.name === 'Rubber boots')
  const sprayerAsset = assetRows.find((a) => a.name === 'Knapsack sprayer')

  await db.insert(assetLogs).values([
    {
      farmId,
      assetId: bootsAsset!.id,
      countAvailable: 7,
      countDamaged: 1,
      condition: 'fair',
      note: 'One pair torn at the sole',
      recordedById: worker1.id,
      verificationStatus: 'reported',
    },
    {
      farmId,
      assetId: sprayerAsset!.id,
      countAvailable: 3,
      countDamaged: 0,
      condition: 'good',
      recordedById: sup1.id,
      verificationStatus: 'verified',
      verifiedById: sup1.id,
      verifiedAt: new Date(now - 3600000),
    },
  ])

  await db.insert(farmEvents).values([
    {
      farmId: farmId,
      actorUserId: sup1.id,
      entityType: 'crop_cycle',
      entityId: coconutCycle.id,
      eventType: 'other',
      beforeValue: { stage: 'germination' },
      afterValue: { stage: 'vegetative' },
      source: 'web',
      metadata: { plotId: coconutPlot.id },
    },
    {
      farmId: farmId,
      actorUserId: worker2.id,
      entityType: 'plot',
      entityId: plantainPlot.id,
      eventType: 'weeded',
      afterValue: { rowsCleared: 12 },
      source: 'web',
      metadata: { templateName: 'Plantain weeding' },
    },
    {
      farmId: farmId,
      actorUserId: worker1.id,
      entityType: 'plot',
      entityId: coconutPlot.id,
      eventType: 'watered',
      afterValue: { durationMinutes: 45 },
      source: 'web',
    },
  ])

  await db.insert(expenses).values([
    {
      farmId: farmId,
      category: 'inputs',
      description: 'Organic fertilizer - coconut Block A',
      amount: 18500,
      recordedById: sup1.id,
      expenseDate: new Date(now - 10 * 86400000),
    },
    {
      farmId: farmId,
      category: 'labour',
      description: 'Weeding crew - plantain Block B',
      amount: 12000,
      recordedById: sup2.id,
      expenseDate: new Date(now - 4 * 86400000),
    },
    {
      farmId: farmId,
      category: 'transport',
      description: 'Delivery to Lagos Wholesale Co.',
      amount: 8500,
      recordedById: owner.id,
      expenseDate: new Date(now - 5 * 86400000),
    },
  ])

  await db.insert(auditEvents).values({
    farmId: farmId,
    userId: owner.id,
    action: 'seed',
    entityType: 'farm',
    entityId: farmId,
    metadata: { note: 'Initial Trovara dummy data loaded' },
  })
}

export async function seedDemoData(): Promise<void> {
  await deleteAllData()
  const [farm] = await db
    .insert(farms)
    .values({
      name: 'Trovara Farm',
      slug: slugify('Trovara Farm'),
      location: 'Abeokuta',
      latitude: '7.1475',
      longitude: '3.3619',
      timezone: 'Africa/Lagos',
    })
    .returning()
  await insertDemoContentForFarm(farm.id)
}

export async function resetDemoData(farmId?: string): Promise<void> {
  if (farmId) {
    await deleteFarmScopedData(farmId)
    await insertDemoContentForFarm(farmId)
    return
  }
  if (process.env.ALLOW_FULL_DB_RESET !== 'true') {
    throw new Error('Full database reset requires ALLOW_FULL_DB_RESET=true')
  }
  await seedDemoData()
}
