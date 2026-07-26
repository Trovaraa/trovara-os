import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendWhatsAppText = vi.fn(async () => undefined)
const getLatestPendingDraftAny = vi.fn()
const cancelActionDraft = vi.fn()
const confirmActionDraft = vi.fn()
const applyConfirmedOpsDraft = vi.fn()
const applyConfirmedInventoryDraft = vi.fn()
const applyConfirmedZoneDraft = vi.fn()
const applyConfirmedLivestockLogDraft = vi.fn()
const applyConfirmedLotDraft = vi.fn()
const executeConfirmedCropCycle = vi.fn()
const executeConfirmedLivestockBatch = vi.fn()

type CanonicalStub = { english: string; sourceLocale: string; status: 'done' | 'pending' }
type CanonicalArgs = { text: string; farmId: string; sourceLocale?: string | null }
const toCanonicalEnglish = vi.fn(
  async ({ text }: CanonicalArgs): Promise<CanonicalStub> => ({
    english: text,
    sourceLocale: 'en',
    status: 'done',
  }),
)
const recordChatMessage = vi.fn(async () => undefined)

const selectLimit = vi.fn(async (): Promise<unknown[]> => [])
const selectWhere = vi.fn(() => ({ limit: selectLimit }))
const selectFrom = vi.fn(() => ({ where: selectWhere }))
const select = vi.fn(() => ({ from: selectFrom }))
const updateWhere = vi.fn(async () => undefined)
const updateSet = vi.fn(() => ({ where: updateWhere }))
const update = vi.fn(() => ({ set: updateSet }))

vi.mock('../db/index.js', () => ({
  db: { select, update },
}))

vi.mock('./content-locale.js', () => ({
  toCanonicalEnglish,
}))

vi.mock('./whatsapp-meta.js', () => ({
  sendWhatsAppText,
}))

vi.mock('./butler-core.js', () => ({
  recordChatMessage,
}))

vi.mock('./task-drafts.js', () => ({
  getLatestPendingDraftAny,
  cancelActionDraft,
  confirmActionDraft,
  draftContentLocale: (draft: {
    sourceLocale?: string | null
    translationStatus?: 'done' | 'pending' | 'failed'
  }) => ({
    sourceLocale: draft.sourceLocale ?? null,
    translationStatus: draft.translationStatus ?? 'done',
  }),
}))

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

const user = {
  id: 'user-1',
  farmId: 'farm-1',
  email: 'a@b.com',
  name: 'Ada',
  role: 'owner' as const,
  mustChangePassword: false,
}

describe('tryHandleWhatsAppDraftConfirm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    applyConfirmedOpsDraft.mockResolvedValue(null)
    applyConfirmedInventoryDraft.mockResolvedValue(null)
    applyConfirmedZoneDraft.mockResolvedValue(null)
    applyConfirmedLivestockLogDraft.mockResolvedValue(null)
    applyConfirmedLotDraft.mockResolvedValue(null)
    selectLimit.mockResolvedValue([])
    toCanonicalEnglish.mockImplementation(async ({ text }: CanonicalArgs) => ({
      english: text,
      sourceLocale: 'en',
      status: 'done',
    }))
  })

  it('ignores non-confirm/cancel text', async () => {
    const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')
    await expect(tryHandleWhatsAppDraftConfirm(user, '234801', 'hello')).resolves.toBe(false)
    expect(getLatestPendingDraftAny).not.toHaveBeenCalled()
  })

  it('returns false when confirm is sent but no pending draft exists', async () => {
    getLatestPendingDraftAny.mockResolvedValue(null)
    const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')
    await expect(tryHandleWhatsAppDraftConfirm(user, '234801', 'CONFIRM')).resolves.toBe(false)
    expect(sendWhatsAppText).not.toHaveBeenCalled()
  })

  it('cancels a pending draft', async () => {
    getLatestPendingDraftAny.mockResolvedValue({ id: 'draft-1' })
    cancelActionDraft.mockResolvedValue(true)
    const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')
    await expect(tryHandleWhatsAppDraftConfirm(user, '234801', 'cancel')).resolves.toBe(true)
    expect(cancelActionDraft).toHaveBeenCalledWith('draft-1', 'user-1')
    expect(sendWhatsAppText).toHaveBeenCalledWith('234801', 'Cancelled. Nothing was written.')
  })

  it('applies ops draft on CONFIRM', async () => {
    getLatestPendingDraftAny.mockResolvedValue({ id: 'draft-1' })
    confirmActionDraft.mockResolvedValue({
      id: 'draft-1',
      farmId: 'farm-1',
      actionType: 'create_task',
      payload: { title: 'Weed' },
      sourceLocale: null,
      translationStatus: 'done',
    })
    applyConfirmedOpsDraft.mockResolvedValue('Task drafted.')
    const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')
    await expect(tryHandleWhatsAppDraftConfirm(user, '234801', 'CONFIRM')).resolves.toBe(true)
    expect(applyConfirmedOpsDraft).toHaveBeenCalledWith(
      user,
      'create_task',
      { title: 'Weed' },
      'whatsapp_confirm',
      { sourceLocale: null, translationStatus: 'done' },
    )
    expect(sendWhatsAppText).toHaveBeenCalledWith('234801', 'Task drafted.')
  })

  it('falls through cascade to crop cycle when earlier applies return null', async () => {
    getLatestPendingDraftAny.mockResolvedValue({ id: 'draft-2' })
    confirmActionDraft.mockResolvedValue({
      id: 'draft-2',
      farmId: 'farm-1',
      actionType: 'create_crop_cycle',
      payload: { plotId: 'p1' },
      sourceLocale: null,
      translationStatus: 'done',
    })
    executeConfirmedCropCycle.mockResolvedValue('Crop cycle created.')
    const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')
    await expect(tryHandleWhatsAppDraftConfirm(user, '234801', 'confirm')).resolves.toBe(true)
    expect(executeConfirmedCropCycle).toHaveBeenCalled()
    expect(sendWhatsAppText).toHaveBeenCalledWith('234801', 'Crop cycle created.')
  })

  it('reports expired draft when confirmActionDraft returns null', async () => {
    getLatestPendingDraftAny.mockResolvedValue({ id: 'draft-3' })
    confirmActionDraft.mockResolvedValue(null)
    const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')
    await expect(tryHandleWhatsAppDraftConfirm(user, '234801', 'CONFIRM')).resolves.toBe(true)
    expect(sendWhatsAppText).toHaveBeenCalledWith('234801', 'Draft expired. Please create it again.')
  })

  describe('canonical-English payloads', () => {
    function pendingDraft(
      payload: Record<string, unknown>,
      actionType = 'create_task',
      locale: { sourceLocale?: string | null; translationStatus?: 'done' | 'pending' } = {
        sourceLocale: 'fr',
        translationStatus: 'pending',
      },
    ) {
      getLatestPendingDraftAny.mockResolvedValue({ id: 'draft-7' })
      confirmActionDraft.mockResolvedValue({
        id: 'draft-7',
        farmId: 'farm-1',
        actionType,
        payload,
        sourceLocale: locale.sourceLocale ?? null,
        translationStatus: locale.translationStatus ?? 'done',
      })
    }

    it('does not translate again when the draft was normalized at creation', async () => {
      pendingDraft(
        { title: 'Weed Block 2' },
        'create_task',
        { sourceLocale: 'fr', translationStatus: 'done' },
      )
      selectLimit.mockResolvedValue([{ sourceLocale: 'fr', translationStatus: 'done' }])
      applyConfirmedOpsDraft.mockResolvedValue('Task created.')
      const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')
      await tryHandleWhatsAppDraftConfirm(user, '234801', 'CONFIRM')

      expect(toCanonicalEnglish).not.toHaveBeenCalled()
      expect(applyConfirmedOpsDraft).toHaveBeenCalledWith(
        user,
        'create_task',
        { title: 'Weed Block 2' },
        'whatsapp_confirm',
        { sourceLocale: 'fr', translationStatus: 'done' },
      )
      expect(update).not.toHaveBeenCalled()
    })

    it('retries a pending draft and passes the post-retry done locale', async () => {
      pendingDraft({ title: 'Désherber Block 2', plotId: 'plot-1' })
      selectLimit.mockResolvedValue([{ sourceLocale: 'fr', translationStatus: 'pending' }])
      toCanonicalEnglish.mockResolvedValue({
        english: 'Weed Block 2',
        sourceLocale: 'fr',
        status: 'done',
      })
      applyConfirmedOpsDraft.mockResolvedValue('Task created.')
      const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')
      await tryHandleWhatsAppDraftConfirm(user, '234801', 'CONFIRM')

      expect(toCanonicalEnglish).toHaveBeenCalledWith({
        text: 'Désherber Block 2',
        farmId: 'farm-1',
        sourceLocale: 'fr',
      })
      expect(applyConfirmedOpsDraft).toHaveBeenCalledWith(
        user,
        'create_task',
        { title: 'Weed Block 2', plotId: 'plot-1' },
        'whatsapp_confirm',
        { sourceLocale: 'fr', translationStatus: 'done' },
      )
      expect(updateSet).toHaveBeenCalledWith({
        payload: { title: 'Weed Block 2', plotId: 'plot-1' },
        translationStatus: 'done',
      })
    })

    it('applies the original text and stays pending when the retry also fails', async () => {
      pendingDraft({ notes: 'stress thermique' }, 'livestock_log')
      selectLimit.mockResolvedValue([{ sourceLocale: 'fr', translationStatus: 'pending' }])
      toCanonicalEnglish.mockResolvedValue({
        english: 'stress thermique',
        sourceLocale: 'fr',
        status: 'pending',
      })
      applyConfirmedLivestockLogDraft.mockResolvedValue('Mortality logged.')
      const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')
      await expect(tryHandleWhatsAppDraftConfirm(user, '234801', 'CONFIRM')).resolves.toBe(true)

      expect(applyConfirmedLivestockLogDraft).toHaveBeenCalledWith(
        user,
        'livestock_log',
        { notes: 'stress thermique' },
        'whatsapp_confirm',
        { sourceLocale: 'fr', translationStatus: 'pending' },
      )
      expect(update).not.toHaveBeenCalled()
      expect(sendWhatsAppText).toHaveBeenCalledWith('234801', 'Mortality logged.')
    })

    it('carries the draft locale onto the lot executor with identifiers verbatim', async () => {
      pendingDraft(
        {
          lotId: 'lot-1',
          lotCode: 'TRV-LOT-2026-014',
          productName: 'Plantain',
          unit: 'crates',
          quantityKg: 24,
          publicNotes: 'Fresh morning harvest',
        },
        'enrich_lot',
        { sourceLocale: 'fr', translationStatus: 'done' },
      )
      selectLimit.mockResolvedValue([{ sourceLocale: 'fr', translationStatus: 'done' }])
      applyConfirmedLotDraft.mockResolvedValue('Lot TRV-LOT-2026-014 updated: 24 crates')
      const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')

      await tryHandleWhatsAppDraftConfirm(user, '234801', 'CONFIRM')

      expect(applyConfirmedLotDraft).toHaveBeenCalledWith(
        user,
        'enrich_lot',
        {
          lotId: 'lot-1',
          lotCode: 'TRV-LOT-2026-014',
          productName: 'Plantain',
          unit: 'crates',
          quantityKg: 24,
          publicNotes: 'Fresh morning harvest',
        },
        { sourceLocale: 'fr', translationStatus: 'done' },
      )
      // Provenance forwarded means the notes are not normalized a second time.
      expect(toCanonicalEnglish).not.toHaveBeenCalled()
    })

    it('canonicalizes a pending lot note exactly once, not twice', async () => {
      pendingDraft(
        { lotId: 'lot-1', lotCode: 'TRV-LOT-2026-014', publicNotes: 'Récolte fraîche du matin' },
        'enrich_lot',
      )
      selectLimit.mockResolvedValue([{ sourceLocale: 'fr', translationStatus: 'pending' }])
      toCanonicalEnglish.mockResolvedValue({
        english: 'Fresh morning harvest',
        sourceLocale: 'fr',
        status: 'done',
      })
      applyConfirmedLotDraft.mockResolvedValue('Lot TRV-LOT-2026-014 updated: 24 crates')
      const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')

      await tryHandleWhatsAppDraftConfirm(user, '234801', 'CONFIRM')

      // The confirm-time retry is the only call: the executor inherits its result
      // instead of normalizing the same line again as it writes the lot.
      expect(toCanonicalEnglish).toHaveBeenCalledTimes(1)
      expect(applyConfirmedLotDraft).toHaveBeenCalledWith(
        user,
        'enrich_lot',
        expect.objectContaining({ publicNotes: 'Fresh morning harvest' }),
        { sourceLocale: 'fr', translationStatus: 'done' },
      )
    })

    it('skips the translation lookup for payloads without free text', async () => {
      pendingDraft(
        { assetId: 'asset-1', countAvailable: 4 },
        'asset_count',
        { sourceLocale: null, translationStatus: 'done' },
      )
      applyConfirmedOpsDraft.mockResolvedValue('Asset count saved.')
      const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')
      await tryHandleWhatsAppDraftConfirm(user, '234801', 'CONFIRM')

      expect(select).not.toHaveBeenCalled()
      expect(toCanonicalEnglish).not.toHaveBeenCalled()
      expect(applyConfirmedOpsDraft).toHaveBeenCalledWith(
        user,
        'asset_count',
        { assetId: 'asset-1', countAvailable: 4 },
        'whatsapp_confirm',
        { sourceLocale: null, translationStatus: 'done' },
      )
    })
  })

  describe('multilingual confirm keywords', () => {
    const CONFIRM_WORDS = [
      ['en', 'CONFIRM'],
      ['fr', 'CONFIRMER'],
      ['yo', 'JẸ́RÌÍ'],
      ['pcm', 'CONFIRM'],
    ] as const

    const CANCEL_WORDS = [
      ['en', 'CANCEL'],
      ['fr', 'ANNULER'],
      ['yo', 'FAGILÉ'],
      ['pcm', 'CANCEL'],
    ] as const

    it.each(CONFIRM_WORDS)('applies the draft when a %s worker sends %s', async (locale, word) => {
      getLatestPendingDraftAny.mockResolvedValue({ id: 'draft-kw' })
      confirmActionDraft.mockResolvedValue({
        id: 'draft-kw',
        farmId: 'farm-1',
        actionType: 'create_task',
        payload: { title: 'Weed Block 2' },
        sourceLocale: null,
        translationStatus: 'done',
      })
      applyConfirmedOpsDraft.mockResolvedValue('Task created.')
      const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')

      await expect(tryHandleWhatsAppDraftConfirm(user, '234801', word, locale)).resolves.toBe(true)
      expect(confirmActionDraft).toHaveBeenCalledWith('draft-kw', 'user-1')
      expect(sendWhatsAppText).toHaveBeenCalledWith('234801', 'Task created.')
    })

    it.each(CANCEL_WORDS)('cancels the draft when a %s worker sends %s', async (locale, word) => {
      getLatestPendingDraftAny.mockResolvedValue({ id: 'draft-kw' })
      cancelActionDraft.mockResolvedValue(true)
      const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')

      await expect(tryHandleWhatsAppDraftConfirm(user, '234801', word, locale)).resolves.toBe(true)
      expect(cancelActionDraft).toHaveBeenCalledWith('draft-kw', 'user-1')
      expect(confirmActionDraft).not.toHaveBeenCalled()
    })

    // A worker whose keyboard has no tone marks types the bare letters.
    it.each(['JERII', 'jeri', 'FAGILE', 'fagile'])('accepts %s without tone marks', async (word) => {
      const { matchDraftKeyword } = await import('./whatsapp-draft-confirm.js')
      expect(matchDraftKeyword(word)).toBe(/fagile/i.test(word) ? 'cancel' : 'confirm')
    })

    it('keeps the lower-case English keywords working', async () => {
      const { matchDraftKeyword } = await import('./whatsapp-draft-confirm.js')
      expect(matchDraftKeyword('confirm')).toBe('confirm')
      expect(matchDraftKeyword('  Cancel ')).toBe('cancel')
    })

    // Widening the keyword set must not start swallowing ordinary conversation.
    it.each([
      'ok',
      'yes',
      'oui',
      'd’accord',
      'no',
      'non',
      'na so',
      'abeg',
      'bẹ́ẹ̀ni',
      'Confirmer la tâche demain ?',
      'annuler la commande de Musa',
      'confirm TRV-ORD-2026-014',
      '/confirm',
      '/cancel',
    ])('leaves %s for the butler', async (text) => {
      getLatestPendingDraftAny.mockResolvedValue({ id: 'draft-kw' })
      const { matchDraftKeyword, tryHandleWhatsAppDraftConfirm } = await import(
        './whatsapp-draft-confirm.js'
      )

      expect(matchDraftKeyword(text)).toBeNull()
      await expect(tryHandleWhatsAppDraftConfirm(user, '234801', text, 'fr')).resolves.toBe(false)
      expect(getLatestPendingDraftAny).not.toHaveBeenCalled()
      expect(sendWhatsAppText).not.toHaveBeenCalled()
    })

    /** The keywords the prompt shouts at the worker, e.g. CONFIRMER and ANNULER. */
    function shoutedKeywords(hint: string): string[] {
      return hint
        .split(/\s+/)
        .map((word) => word.replace(/[.,;:?!«»"']/g, ''))
        .filter((word) => word.length > 1 && /\p{L}/u.test(word) && word === word.toUpperCase())
    }

    it.each(['en', 'fr', 'yo', 'pcm'] as const)(
      'prompts a %s worker with keywords the matcher accepts',
      async (locale) => {
        const { draftConfirmHint, matchDraftKeyword } = await import(
          './whatsapp-draft-confirm.js'
        )
        const [confirmWord, cancelWord] = shoutedKeywords(draftConfirmHint(locale))

        expect(confirmWord).toBeDefined()
        expect(cancelWord).toBeDefined()
        expect(matchDraftKeyword(confirmWord!)).toBe('confirm')
        expect(matchDraftKeyword(cancelWord!)).toBe('cancel')
      },
    )

    it('keeps the English hint wording the offer drafts already send', async () => {
      const { draftConfirmHint } = await import('./whatsapp-draft-confirm.js')
      expect(draftConfirmHint('en')).toBe('Reply CONFIRM to save, or CANCEL.')
      expect(draftConfirmHint(null)).toBe('Reply CONFIRM to save, or CANCEL.')
      expect(draftConfirmHint('fr')).toContain('CONFIRMER')
      expect(draftConfirmHint('fr')).toContain('ANNULER')
    })
  })

  describe('assistant replies in the chat log', () => {
    it('stores the English reply and keeps the French wording recoverable', async () => {
      getLatestPendingDraftAny.mockResolvedValue({ id: 'draft-log' })
      cancelActionDraft.mockResolvedValue(true)
      const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')

      await tryHandleWhatsAppDraftConfirm(user, '234801', 'ANNULER', 'fr')

      expect(sendWhatsAppText).toHaveBeenCalledWith(
        '234801',
        'Annulé. Rien n’a été enregistré.',
      )
      expect(recordChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'assistant',
          direction: 'outbound',
          text: 'Cancelled. Nothing was written.',
          extra: {
            sourceLocale: 'fr',
            translationStatus: 'done',
            originalText: 'Annulé. Rien n’a été enregistré.',
          },
        }),
      )
      // The English came straight from the locale table — nothing to translate.
      expect(toCanonicalEnglish).not.toHaveBeenCalled()
    })

    it('omits the original copy when the reply was already delivered in English', async () => {
      getLatestPendingDraftAny.mockResolvedValue({ id: 'draft-log' })
      confirmActionDraft.mockResolvedValue({
        id: 'draft-log',
        farmId: 'farm-1',
        actionType: 'create_task',
        payload: { title: 'Weed Block 2' },
        sourceLocale: null,
        translationStatus: 'done',
      })
      applyConfirmedOpsDraft.mockResolvedValue('Task created.')
      const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')

      await tryHandleWhatsAppDraftConfirm(user, '234801', 'JẸ́RÌÍ', 'yo')

      expect(recordChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'assistant',
          text: 'Task created.',
          extra: { sourceLocale: 'yo', translationStatus: 'done' },
        }),
      )
      expect(toCanonicalEnglish).not.toHaveBeenCalled()
    })
  })

  it('surfaces apply errors to WhatsApp', async () => {
    getLatestPendingDraftAny.mockResolvedValue({ id: 'draft-4' })
    confirmActionDraft.mockResolvedValue({
      id: 'draft-4',
      farmId: 'farm-1',
      actionType: 'create_task',
      payload: {},
      sourceLocale: null,
      translationStatus: 'done',
    })
    applyConfirmedOpsDraft.mockRejectedValue(new Error('boom'))
    const { tryHandleWhatsAppDraftConfirm } = await import('./whatsapp-draft-confirm.js')
    await expect(tryHandleWhatsAppDraftConfirm(user, '234801', 'CONFIRM')).resolves.toBe(true)
    expect(sendWhatsAppText).toHaveBeenCalledWith('234801', 'boom')
  })
})
