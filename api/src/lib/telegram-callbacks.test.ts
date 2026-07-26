import { beforeEach, describe, expect, it, vi } from 'vitest'

const answerTelegramCallbackQuery = vi.fn(async () => undefined)
const sendTelegramMessage = vi.fn(async () => undefined)
const sendTelegramPhoto = vi.fn(async () => undefined)
const cancelActionDraft = vi.fn()
const confirmActionDraft = vi.fn()
const applyConfirmedOpsDraft = vi.fn()
const applyConfirmedInventoryDraft = vi.fn()
const applyConfirmedZoneDraft = vi.fn()
const applyConfirmedLivestockLogDraft = vi.fn()
const applyConfirmedLotDraft = vi.fn()
const executeConfirmedCropCycle = vi.fn()
const executeConfirmedLivestockBatch = vi.fn()
const transitionTaskFromCallback = vi.fn()
const setUserPreferredLocale = vi.fn()
const transitionOrderFromCallback = vi.fn()
const findPrintableLotById = vi.fn()
const buildLotQrPng = vi.fn()

vi.mock('./telegram.js', () => ({
  answerTelegramCallbackQuery,
  sendTelegramMessage,
  sendTelegramPhoto,
}))

vi.mock('./task-drafts.js', () => ({
  cancelActionDraft,
  confirmActionDraft,
}))

type DraftLike = {
  payload: Record<string, unknown>
  sourceLocale?: string | null
  translationStatus?: 'done' | 'pending' | 'failed'
}

/**
 * The no-op case: a draft already in English passes straight through. Restored
 * in `beforeEach` so these tests read the same as before the confirm-time retry
 * existed; the tests that care about the retry override it.
 */
const passThroughPayload = async (draft: DraftLike) => ({
  payload: draft.payload,
  locale: {
    sourceLocale: draft.sourceLocale ?? null,
    translationStatus: draft.translationStatus ?? 'done',
  },
})

const canonicalDraftPayload = vi.fn(passThroughPayload)

vi.mock('./draft-canonical.js', () => ({ canonicalDraftPayload }))

vi.mock('./action-draft-ops.js', () => ({
  applyConfirmedOpsDraft,
}))

vi.mock('./action-draft-inventory.js', () => ({
  applyConfirmedInventoryDraft,
}))

vi.mock('./action-draft-zones.js', () => ({
  applyConfirmedZoneDraft,
}))

vi.mock('./action-draft-livestock-log.js', () => ({
  applyConfirmedLivestockLogDraft,
}))

vi.mock('./lot-enrich.js', () => ({
  applyConfirmedLotDraft,
}))

vi.mock('./action-draft-farm.js', () => ({
  executeConfirmedCropCycle,
  executeConfirmedLivestockBatch,
}))

vi.mock('./staff-ops.js', () => ({
  transitionTaskFromCallback,
}))

vi.mock('./order-fulfillment.js', () => ({
  setUserPreferredLocale,
  transitionOrderFromCallback,
}))

vi.mock('./order-messages.js', () => ({
  languageSavedMessage: (locale: string) => `Saved ${locale}`,
  orderCommandHelp: () => 'Order help',
}))

vi.mock('./rbac.js', () => ({
  canManageOrders: () => true,
}))

vi.mock('./lot-print.js', () => ({
  findPrintableLotById,
  buildLotQrPng,
}))

const toCanonicalEnglish = vi.fn()

vi.mock('./content-locale.js', () => ({
  toCanonicalEnglish,
}))

const dbUser = {
  id: 'user-1',
  farmId: 'farm-1',
  email: 'a@b.com',
  name: 'Ada',
  role: 'owner',
  mustChangePassword: false,
  preferredLocale: 'en',
  phone: null,
  active: true,
  passwordHash: 'x',
  createdAt: new Date(),
  updatedAt: new Date(),
} as never

function callback(data: string) {
  return {
    id: 'cb-1',
    data,
    message: { chat: { id: 99 } },
  }
}

describe('telegram-callbacks handleCallbackQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    canonicalDraftPayload.mockImplementation(passThroughPayload)
    applyConfirmedOpsDraft.mockResolvedValue(null)
    applyConfirmedInventoryDraft.mockResolvedValue(null)
    applyConfirmedZoneDraft.mockResolvedValue(null)
    applyConfirmedLivestockLogDraft.mockResolvedValue(null)
    applyConfirmedLotDraft.mockResolvedValue(null)
  })

  it('no-ops when callback has no chat or data', async () => {
    const { handleCallbackQuery } = await import('./telegram-callbacks.js')
    await handleCallbackQuery(dbUser, { id: 'cb' } as never)
    expect(answerTelegramCallbackQuery).not.toHaveBeenCalled()
  })

  it('answers language callbacks', async () => {
    const { handleCallbackQuery } = await import('./telegram-callbacks.js')
    await handleCallbackQuery(dbUser, callback('lang:yo') as never)
    expect(answerTelegramCallbackQuery).toHaveBeenCalledWith('cb-1')
    expect(setUserPreferredLocale).toHaveBeenCalledWith('user-1', 'yo')
    expect(sendTelegramMessage).toHaveBeenCalledWith(99, 'Saved yo')
  })

  it('routes task callbacks', async () => {
    transitionTaskFromCallback.mockResolvedValue({ reply: 'Task started' })
    const { handleCallbackQuery } = await import('./telegram-callbacks.js')
    await handleCallbackQuery(dbUser, callback('task:start:task-1') as never)
    expect(transitionTaskFromCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        action: 'start',
      }),
    )
    expect(sendTelegramMessage).toHaveBeenCalledWith(99, 'Task started')
  })

  it('cancels drafts via confirm keyboard', async () => {
    cancelActionDraft.mockResolvedValue(true)
    const { handleCallbackQuery } = await import('./telegram-callbacks.js')
    await handleCallbackQuery(dbUser, callback('cancel:draft-9') as never)
    expect(cancelActionDraft).toHaveBeenCalledWith('draft-9', 'user-1')
    expect(sendTelegramMessage).toHaveBeenCalledWith(99, 'Cancelled. Nothing was written.')
  })

  it('applies confirmed inventory draft', async () => {
    confirmActionDraft.mockResolvedValue({
      id: 'draft-9',
      farmId: 'farm-1',
      actionType: 'stock_move',
      payload: { qty: 1 },
      sourceLocale: null,
      translationStatus: 'done',
    })
    applyConfirmedInventoryDraft.mockResolvedValue('Stock moved.')
    const { handleCallbackQuery } = await import('./telegram-callbacks.js')
    await handleCallbackQuery(dbUser, callback('confirm:draft-9') as never)
    expect(applyConfirmedInventoryDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      'stock_move',
      { qty: 1 },
      'telegram_confirm',
      { sourceLocale: null, translationStatus: 'done' },
    )
    expect(sendTelegramMessage).toHaveBeenCalledWith(99, 'Stock moved.')
  })

  it('applies the stored English payload without translating again', async () => {
    confirmActionDraft.mockResolvedValue({
      id: 'draft-10',
      farmId: 'farm-1',
      actionType: 'livestock_log',
      payload: {
        batchName: 'Noiler A',
        logType: 'mortality',
        headCount: 3,
        notes: 'heat stress in the afternoon',
      },
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
    applyConfirmedLivestockLogDraft.mockResolvedValue('✅ mortality logged for Noiler A.')
    const { handleCallbackQuery } = await import('./telegram-callbacks.js')

    await handleCallbackQuery(dbUser, callback('confirm:draft-10') as never)

    expect(applyConfirmedLivestockLogDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      'livestock_log',
      expect.objectContaining({ notes: 'heat stress in the afternoon' }),
      'telegram_confirm',
      { sourceLocale: 'fr', translationStatus: 'done' },
    )
    // Confirmation is free: the draft was normalized when it was created.
    expect(toCanonicalEnglish).not.toHaveBeenCalled()
  })

  it('passes draft locale metadata into the ops executor', async () => {
    confirmActionDraft.mockResolvedValue({
      id: 'draft-locale',
      farmId: 'farm-1',
      actionType: 'create_task',
      payload: { title: 'Weed Block 2' },
      sourceLocale: 'yo',
      translationStatus: 'pending',
    })
    applyConfirmedOpsDraft.mockResolvedValue('Task created.')
    const { handleCallbackQuery } = await import('./telegram-callbacks.js')

    await handleCallbackQuery(dbUser, callback('confirm:draft-locale') as never)

    expect(applyConfirmedOpsDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      'create_task',
      { title: 'Weed Block 2' },
      'telegram_confirm',
      { sourceLocale: 'yo', translationStatus: 'pending' },
    )
  })

  it('retries a pending draft at confirm time, like WhatsApp does', async () => {
    const draft = {
      id: 'draft-retry',
      farmId: 'farm-1',
      actionType: 'create_task',
      payload: { title: 'Désherber le bloc 2' },
      sourceLocale: 'fr',
      translationStatus: 'pending',
    }
    confirmActionDraft.mockResolvedValue(draft)
    // The LLM was down when the draft was made and is back now.
    canonicalDraftPayload.mockResolvedValue({
      payload: { title: 'Weed Block 2' },
      locale: { sourceLocale: 'fr', translationStatus: 'done' },
    })
    applyConfirmedOpsDraft.mockResolvedValue('Task created.')
    const { handleCallbackQuery } = await import('./telegram-callbacks.js')

    await handleCallbackQuery(dbUser, callback('confirm:draft-retry') as never)

    expect(canonicalDraftPayload).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft-retry' }))
    // The retried English reaches the row, marked done rather than the draft's
    // stale 'pending'.
    expect(applyConfirmedOpsDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      'create_task',
      { title: 'Weed Block 2' },
      'telegram_confirm',
      { sourceLocale: 'fr', translationStatus: 'done' },
    )
  })

  it('applies the retried payload to every executor in the ladder', async () => {
    confirmActionDraft.mockResolvedValue({
      id: 'draft-retry-2',
      farmId: 'farm-1',
      actionType: 'livestock_log',
      payload: { notes: 'stress thermique' },
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
    canonicalDraftPayload.mockResolvedValue({
      payload: { notes: 'heat stress' },
      locale: { sourceLocale: 'fr', translationStatus: 'done' },
    })
    applyConfirmedLivestockLogDraft.mockResolvedValue('✅ logged.')
    const { handleCallbackQuery } = await import('./telegram-callbacks.js')

    await handleCallbackQuery(dbUser, callback('confirm:draft-retry-2') as never)

    // Executors earlier in the ladder must see the retried payload too, or the
    // fix only covers whichever one happens to claim the draft.
    for (const executor of [applyConfirmedOpsDraft, applyConfirmedInventoryDraft]) {
      expect(executor).toHaveBeenCalledWith(
        expect.anything(),
        'livestock_log',
        { notes: 'heat stress' },
        'telegram_confirm',
        { sourceLocale: 'fr', translationStatus: 'done' },
      )
    }
  })

  it('carries the draft locale onto the lot executor so notes are not re-normalized', async () => {
    confirmActionDraft.mockResolvedValue({
      id: 'draft-lot',
      farmId: 'farm-1',
      actionType: 'enrich_lot',
      payload: {
        lotId: 'lot-1',
        lotCode: 'TRV-LOT-2026-014',
        productName: 'Plantain',
        unit: 'crates',
        quantityKg: 24,
        publicNotes: 'Fresh morning harvest',
      },
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
    applyConfirmedLotDraft.mockResolvedValue('Lot TRV-LOT-2026-014 updated: 24 crates')
    const { handleCallbackQuery } = await import('./telegram-callbacks.js')

    await handleCallbackQuery(dbUser, callback('confirm:draft-lot') as never)

    expect(applyConfirmedLotDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      'enrich_lot',
      expect.objectContaining({
        publicNotes: 'Fresh morning harvest',
        lotCode: 'TRV-LOT-2026-014',
      }),
      { sourceLocale: 'fr', translationStatus: 'done' },
    )
    // The draft was normalized when it was created; confirming costs nothing.
    expect(toCanonicalEnglish).not.toHaveBeenCalled()
  })

  it('forwards a pending lot draft locale so the row inherits the debt', async () => {
    confirmActionDraft.mockResolvedValue({
      id: 'draft-lot-2',
      farmId: 'farm-1',
      actionType: 'verify_lot',
      payload: { lotId: 'lot-1', status: 'rejected', note: 'cageots abîmés' },
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
    applyConfirmedLotDraft.mockResolvedValue('Lot TRV-LOT-2026-014 rejected.')
    const { handleCallbackQuery } = await import('./telegram-callbacks.js')

    await handleCallbackQuery(dbUser, callback('confirm:draft-lot-2') as never)

    expect(applyConfirmedLotDraft).toHaveBeenCalledWith(
      expect.anything(),
      'verify_lot',
      expect.objectContaining({ note: 'cageots abîmés' }),
      { sourceLocale: 'fr', translationStatus: 'pending' },
    )
  })

  // Telegram reads the action from the inline button, never from typed text, so
  // it has no keyword to translate and never had the English-only keyword bug.
  it.each(['fr', 'yo', 'pcm', 'en'])(
    'confirms a draft from the button for a %s worker without reading any keyword',
    async (preferredLocale) => {
      confirmActionDraft.mockResolvedValue({
        id: 'draft-11',
        farmId: 'farm-1',
        actionType: 'create_task',
        payload: { title: 'Weed Block 2' },
        sourceLocale: preferredLocale === 'en' ? null : preferredLocale,
        translationStatus: 'done',
      })
      applyConfirmedOpsDraft.mockResolvedValue('Task created.')
      const { handleCallbackQuery } = await import('./telegram-callbacks.js')

      await handleCallbackQuery(
        { ...(dbUser as object), preferredLocale } as never,
        callback('confirm:draft-11') as never,
      )

      expect(confirmActionDraft).toHaveBeenCalledWith('draft-11', 'user-1')
      expect(applyConfirmedOpsDraft).toHaveBeenCalledWith(
        expect.anything(),
        'create_task',
        { title: 'Weed Block 2' },
        'telegram_confirm',
        {
          sourceLocale: preferredLocale === 'en' ? null : preferredLocale,
          translationStatus: 'done',
        },
      )
      expect(sendTelegramMessage).toHaveBeenCalledWith(99, 'Task created.')
    },
  )

  it('rejects cross-farm drafts', async () => {
    confirmActionDraft.mockResolvedValue({
      id: 'draft-9',
      farmId: 'other-farm',
      actionType: 'create_task',
      payload: {},
    })
    const { handleCallbackQuery } = await import('./telegram-callbacks.js')
    await handleCallbackQuery(dbUser, callback('confirm:draft-9') as never)
    expect(sendTelegramMessage).toHaveBeenCalledWith(99, 'Draft is not valid for this farm.')
    expect(applyConfirmedOpsDraft).not.toHaveBeenCalled()
  })
})
