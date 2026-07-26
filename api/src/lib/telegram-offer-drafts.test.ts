import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CANONICAL_CROP_TYPES } from './crop-normalize.js'
import { isNoilerBatch } from './species-normalize.js'

const sendTelegramMessage = vi.fn(
  async (_chatId: number, _text: string, _opts?: Record<string, unknown>) => undefined,
)
const confirmCancelKeyboard = vi.fn((draftId: string) => ({ inline_keyboard: [[{ text: 'Confirm', callback_data: `confirm:${draftId}` }]] }))
const prepareCreateTaskDraft = vi.fn()
const prepareCensusDraft = vi.fn()
const prepareLivestockLogDraft = vi.fn()
const prepareVerifyLotDraft = vi.fn()
const applyLotEnrichText = vi.fn()
const storeActionDraft = vi.fn()
const canAssignTasks = vi.fn(() => true)
const resolvePlotByName = vi.fn()
const applyPoultryTypeAnswer = vi.fn()
const toCanonicalEnglish = vi.fn()

/** Locale columns written on the draft row after it is stored. */
const draftLocaleUpdates: Record<string, unknown>[] = []

vi.mock('./telegram.js', () => ({
  sendTelegramMessage,
  confirmCancelKeyboard,
}))

vi.mock('./content-locale.js', () => ({
  toCanonicalEnglish,
}))

vi.mock('../db/index.js', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          draftLocaleUpdates.push(values)
        },
      }),
    }),
  },
}))

vi.mock('./rbac.js', () => ({
  canAssignTasks,
}))

vi.mock('./task-drafts.js', () => ({
  storeActionDraft,
}))

vi.mock('./action-draft-ops.js', () => ({
  prepareCreateTaskDraft,
  prepareCensusDraft,
  prepareAssetCountDraft: vi.fn(),
  parseAssetCountIntent: vi.fn(),
  parseCensusIntent: vi.fn(),
}))

vi.mock('./action-draft-farm.js', () => ({
  resolvePlotByName,
  applyPoultryTypeAnswer,
  parseCropCycleIntent: vi.fn(),
  parseLivestockBatchIntent: vi.fn(),
}))

vi.mock('./action-draft-inventory.js', () => ({
  prepareStockMoveDraft: vi.fn(),
  prepareOpeningCountDraft: vi.fn(),
  prepareLowStockAckDraft: vi.fn(),
  parseStockMoveIntent: vi.fn(),
  parseOpeningCountIntent: vi.fn(),
  parseLowStockAckIntent: vi.fn(),
}))

vi.mock('./action-draft-zones.js', () => ({
  prepareCreateZoneDraft: vi.fn(),
  prepareCreatePlotDraft: vi.fn(),
  parseCreateZoneIntent: vi.fn(),
  parseCreatePlotIntent: vi.fn(),
}))

vi.mock('./action-draft-livestock-log.js', () => ({
  prepareLivestockLogDraft,
  parseLivestockLogIntent: vi.fn(),
}))

vi.mock('./lot-enrich.js', () => ({
  startLotEnrichDraft: vi.fn(),
  applyLotEnrichText,
  prepareVerifyLotDraft,
  parseVerifyLotIntent: vi.fn(),
}))

const user = {
  id: 'user-1',
  farmId: 'farm-1',
  email: 'a@b.com',
  name: 'Ada',
  role: 'supervisor' as const,
  mustChangePassword: false,
}

/** Default: the service reports the text is already English and costs nothing. */
function passthroughEnglish() {
  toCanonicalEnglish.mockImplementation(async ({ text }: { text: string }) => ({
    english: text,
    sourceLocale: 'en',
    status: 'done',
  }))
}

/** The service translated French prose into English. */
function translatesFrenchTo(english: string) {
  toCanonicalEnglish.mockResolvedValue({ english, sourceLocale: 'fr', status: 'done' })
}

describe('telegram-offer-drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    draftLocaleUpdates.length = 0
    canAssignTasks.mockReturnValue(true)
    passthroughEnglish()
  })

  it('offerTaskDraft attaches confirm/cancel keyboard', async () => {
    prepareCreateTaskDraft.mockResolvedValue({
      ok: true,
      preview: 'Create task: Scout',
      draftId: 'tg-d1',
    })
    const { offerTaskDraft } = await import('./telegram-offer-drafts.js')
    await offerTaskDraft(user, 42, 'Scout')
    expect(prepareCreateTaskDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'telegram',
        externalChatId: '42',
      }),
    )
    expect(confirmCancelKeyboard).toHaveBeenCalledWith('tg-d1')
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      42,
      'Create task: Scout\n\nTap Confirm or Cancel below.',
      { replyMarkup: expect.any(Object) },
    )
  })

  it('offerCensusDraft appends create-plot hint on not-found', async () => {
    prepareCensusDraft.mockResolvedValue({ ok: false, error: 'Block not found' })
    const { offerCensusDraft } = await import('./telegram-offer-drafts.js')
    await offerCensusDraft(user, 7, { plotName: 'X', cropType: 'maize', count: 1 } as never)
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      7,
      expect.stringContaining('Create plot: Name zone=ZoneName'),
    )
  })

  it('offerCropCycleDraft stores draft and keyboard', async () => {
    resolvePlotByName.mockResolvedValue({ id: 'p1', name: 'Block 1' })
    storeActionDraft.mockResolvedValue({ id: 'stored-1' })
    const { offerCropCycleDraft } = await import('./telegram-offer-drafts.js')
    await offerCropCycleDraft(user, 9, {
      plotName: 'Block 1',
      cropType: 'cassava',
      plantedAt: '2026-02-01',
    } as never)
    expect(storeActionDraft).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'create_crop_cycle', channel: 'telegram' }),
    )
    expect(confirmCancelKeyboard).toHaveBeenCalledWith('stored-1')
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      9,
      expect.stringContaining('Draft crop cycle'),
      expect.objectContaining({ replyMarkup: expect.any(Object) }),
    )
  })

  describe('canonical English payloads', () => {
    it('stores a French task title in English while previewing it in French', async () => {
      translatesFrenchTo('Harvest the bananas in Bloc A')
      prepareCreateTaskDraft.mockImplementation(
        async ({ title }: { title: string }) => ({
          ok: true,
          draftId: 'draft-fr',
          preview: `Draft task ready:\nTitle: ${title}`,
        }),
      )
      const { offerTaskDraft } = await import('./telegram-offer-drafts.js')

      await offerTaskDraft(user, 42, 'Récolter les bananes au Bloc A', undefined, 'fr')

      expect(prepareCreateTaskDraft).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Harvest the bananas in Bloc A' }),
      )
      expect(sendTelegramMessage).toHaveBeenCalledWith(
        42,
        'Draft task ready:\nTitle: Récolter les bananes au Bloc A\n\nTap Confirm or Cancel below.',
        { replyMarkup: expect.any(Object) },
      )
      expect(draftLocaleUpdates).toEqual([
        { sourceLocale: 'fr', translationStatus: 'done' },
      ])
    })

    it('stores English prose unchanged and leaves the draft locale columns alone', async () => {
      prepareCreateTaskDraft.mockResolvedValue({
        ok: true,
        draftId: 'draft-en',
        preview: 'Draft task ready:\nTitle: Harvest the bananas in Bloc A',
      })
      const { offerTaskDraft } = await import('./telegram-offer-drafts.js')

      await offerTaskDraft(user, 42, 'Harvest the bananas in Bloc A', undefined, 'en')

      expect(prepareCreateTaskDraft).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Harvest the bananas in Bloc A' }),
      )
      expect(draftLocaleUpdates).toEqual([])
    })

    it('persists a pending translation with the original text and still offers the draft', async () => {
      toCanonicalEnglish.mockResolvedValue({
        english: 'Trois poulets sont morts ce matin',
        sourceLocale: 'fr',
        status: 'pending',
      })
      prepareLivestockLogDraft.mockImplementation(
        async ({ notes }: { notes?: string }) => ({
          ok: true,
          draftId: 'draft-pending',
          preview: `Draft livestock log ready:\nNotes: ${notes}`,
        }),
      )
      const { offerLivestockLogDraft } = await import('./telegram-offer-drafts.js')

      await offerLivestockLogDraft(
        user,
        42,
        {
          logType: 'mortality',
          batchQuery: 'Noiler A',
          headCount: 3,
          notes: 'Trois poulets sont morts ce matin',
        } as never,
        'fr',
      )

      expect(prepareLivestockLogDraft).toHaveBeenCalledWith(
        expect.objectContaining({ notes: 'Trois poulets sont morts ce matin' }),
      )
      expect(draftLocaleUpdates).toEqual([
        { sourceLocale: 'fr', translationStatus: 'pending' },
      ])
      expect(sendTelegramMessage).toHaveBeenCalledWith(
        42,
        expect.stringContaining('Trois poulets sont morts ce matin'),
        { replyMarkup: expect.any(Object) },
      )
    })

    it('translates livestock log notes but keeps the batch name', async () => {
      translatesFrenchTo('heat stress in the afternoon')
      prepareLivestockLogDraft.mockResolvedValue({
        ok: true,
        draftId: 'draft-log',
        preview: 'Draft livestock log ready:\nBatch: Noiler A',
      })
      const { offerLivestockLogDraft } = await import('./telegram-offer-drafts.js')

      await offerLivestockLogDraft(
        user,
        42,
        {
          logType: 'feeding',
          batchQuery: 'Noiler A',
          notes: 'stress thermique dans l’après-midi',
        } as never,
        'fr',
      )

      expect(toCanonicalEnglish).toHaveBeenCalledTimes(1)
      expect(toCanonicalEnglish).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'stress thermique dans l’après-midi' }),
      )
      expect(prepareLivestockLogDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          batchQuery: 'Noiler A',
          notes: 'heat stress in the afternoon',
        }),
      )
    })

    it('never sends plot names, crop types or lot codes to the translator', async () => {
      prepareCensusDraft.mockResolvedValue({ ok: true, draftId: 'd1', preview: 'Draft census' })
      prepareVerifyLotDraft.mockResolvedValue({ ok: true, draftId: 'd2', preview: 'Draft verify' })
      const { offerCensusDraft, offerVerifyLotDraft } = await import(
        './telegram-offer-drafts.js'
      )

      await offerCensusDraft(
        user,
        42,
        { blockName: 'Bloc A', cropType: 'plantain', plantCount: 120 } as never,
      )
      await offerVerifyLotDraft(
        user,
        42,
        { lotCode: 'TRV-ORD-2026-014', status: 'verified' } as never,
        'fr',
      )

      expect(toCanonicalEnglish).not.toHaveBeenCalled()
      expect(prepareCensusDraft).toHaveBeenCalledWith(
        expect.objectContaining({ blockName: 'Bloc A', cropType: 'plantain' }),
      )
      expect(prepareVerifyLotDraft).toHaveBeenCalledWith(
        expect.objectContaining({ lotCode: 'TRV-ORD-2026-014' }),
      )
    })

    it('canonicalizes lot notes lines while keeping the command keyword', async () => {
      translatesFrenchTo('Fresh morning harvest')
      applyLotEnrichText.mockResolvedValue({
        handled: true,
        draftId: 'lot-1',
        reply: 'Draft public notes saved. Confirm when ready.',
      })
      const { tryApplyLotEnrichText } = await import('./telegram-offer-drafts.js')

      const handled = await tryApplyLotEnrichText(user, 42, 'notes Récolte fraîche du matin', 'fr')

      expect(handled).toBe(true)
      expect(applyLotEnrichText).toHaveBeenCalledWith(user, 'notes Fresh morning harvest')
      expect(draftLocaleUpdates).toEqual([
        { sourceLocale: 'fr', translationStatus: 'done' },
      ])
    })

    it('resolves a French crop name to its playbook key instead of translating it', async () => {
      resolvePlotByName.mockResolvedValue({ id: 'p1', name: 'Block 1' })
      storeActionDraft.mockResolvedValue({ id: 'stored-fr' })
      const { offerCropCycleDraft } = await import('./telegram-offer-drafts.js')

      await offerCropCycleDraft(user, 9, {
        plotName: 'Block 1',
        cropType: 'banane plantain',
        plantedAt: '2026-02-01',
      } as never)

      const { payload } = storeActionDraft.mock.calls[0]![0]
      expect(payload.cropType).toBe('plantain')
      expect(CANONICAL_CROP_TYPES).toContain(payload.cropType)
      expect(toCanonicalEnglish).not.toHaveBeenCalled()
    })

    it('normalizes the census crop type as well', async () => {
      prepareCensusDraft.mockResolvedValue({ ok: true, draftId: 'd1', preview: 'Draft census' })
      const { offerCensusDraft } = await import('./telegram-offer-drafts.js')

      await offerCensusDraft(user, 42, {
        blockName: 'Bloc A',
        cropType: 'Noix de Coco',
        plantCount: 120,
      } as never)

      expect(prepareCensusDraft).toHaveBeenCalledWith(
        expect.objectContaining({ blockName: 'Bloc A', cropType: 'coconut' }),
      )
    })

    it('stores a crop with no playbook exactly as the worker typed it', async () => {
      resolvePlotByName.mockResolvedValue({ id: 'p1', name: 'Block 1' })
      storeActionDraft.mockResolvedValue({ id: 'stored-unknown' })
      const { offerCropCycleDraft } = await import('./telegram-offer-drafts.js')

      await offerCropCycleDraft(user, 9, {
        plotName: 'Block 1',
        cropType: 'Igname blanche',
        plantedAt: '2026-02-01',
      } as never)

      expect(storeActionDraft.mock.calls[0]![0].payload.cropType).toBe('Igname blanche')
      expect(toCanonicalEnglish).not.toHaveBeenCalled()
    })

    it('leaves a lot qty line untouched', async () => {
      applyLotEnrichText.mockResolvedValue({
        handled: true,
        draftId: 'lot-2',
        reply: 'Draft qty set to 12 crates. Confirm when ready.',
      })
      const { tryApplyLotEnrichText } = await import('./telegram-offer-drafts.js')

      await tryApplyLotEnrichText(user, 42, 'qty 12 crates', 'fr')

      expect(toCanonicalEnglish).not.toHaveBeenCalled()
      expect(applyLotEnrichText).toHaveBeenCalledWith(user, 'qty 12 crates')
    })
  })

  describe('species as a lookup key', () => {
    const frenchBatch = {
      name: 'Shed A',
      species: 'poulet noiler',
      headCount: 200,
      acquiredAt: '2026-02-01',
    }

    beforeEach(() => {
      storeActionDraft.mockResolvedValue({ id: 'stored-species' })
    })

    it('resolves a French species to the canonical value instead of translating it', async () => {
      const { offerLivestockBatchDraft } = await import('./telegram-offer-drafts.js')

      await offerLivestockBatchDraft(user, 9, frenchBatch as never)

      const { payload } = storeActionDraft.mock.calls[0]![0]
      expect(payload.species).toBe('noiler')
      expect(isNoilerBatch({ species: payload.species as string })).toBe(true)
      expect(toCanonicalEnglish).not.toHaveBeenCalled()
    })

    it('still shows the worker the words they wrote', async () => {
      const { offerLivestockBatchDraft } = await import('./telegram-offer-drafts.js')

      await offerLivestockBatchDraft(user, 9, frenchBatch as never)

      expect(sendTelegramMessage).toHaveBeenCalledWith(
        9,
        expect.stringContaining('poulet noiler'),
        expect.objectContaining({ replyMarkup: expect.any(Object) }),
      )
      // And carries them into the confirmation reply.
      expect(storeActionDraft.mock.calls[0]![0].payload.speciesTyped).toBe('poulet noiler')
    })

    it('stores a species the enum cannot express exactly as the worker typed it', async () => {
      const { offerLivestockBatchDraft } = await import('./telegram-offer-drafts.js')

      await offerLivestockBatchDraft(
        user,
        9,
        { ...frenchBatch, species: 'Kuroiler cockerel' } as never,
      )

      expect(storeActionDraft.mock.calls[0]![0].payload.species).toBe('Kuroiler cockerel')
      expect(toCanonicalEnglish).not.toHaveBeenCalled()
    })
  })

  describe('the poultry type the worker did not say', () => {
    const batch = {
      name: 'Shed A',
      species: 'chickens',
      headCount: 200,
      acquiredAt: '2026-02-01',
    }

    beforeEach(() => {
      storeActionDraft.mockResolvedValue({ id: 'stored-poultry' })
    })

    it('asks which type instead of offering the draft to confirm', async () => {
      const { offerLivestockBatchDraft } = await import('./telegram-offer-drafts.js')

      await offerLivestockBatchDraft(user, 9, batch as never)

      expect(storeActionDraft.mock.calls[0]![0].payload.awaitingBatchType).toBe(true)
      expect(confirmCancelKeyboard).not.toHaveBeenCalled()
      const [chatId, text, opts] = sendTelegramMessage.mock.calls[0]!
      expect(chatId).toBe(9)
      expect(text).toContain('noiler | layer | pullet | other')
      expect(text).toContain('chickens')
      expect(opts).toBeUndefined()
    })

    it('asks in the worker\u2019s own language', async () => {
      const { offerLivestockBatchDraft } = await import('./telegram-offer-drafts.js')

      await offerLivestockBatchDraft(user, 9, batch as never, 'fr')
      await offerLivestockBatchDraft(user, 9, batch as never, 'yo')

      expect(sendTelegramMessage.mock.calls[0]![1]).toContain('volaille')
      expect(sendTelegramMessage.mock.calls[1]![1]).toContain('adìẹ')
      // The options stay the values the column accepts, in every language.
      for (const call of sendTelegramMessage.mock.calls) {
        expect(call[1]).toContain('noiler | layer | pullet | other')
      }
    })

    it('does not ask when the words already name a type', async () => {
      const { offerLivestockBatchDraft } = await import('./telegram-offer-drafts.js')

      await offerLivestockBatchDraft(user, 9, { ...batch, species: 'poulet noiler' } as never)

      expect(storeActionDraft.mock.calls[0]![0].payload.awaitingBatchType).toBe(false)
      expect(confirmCancelKeyboard).toHaveBeenCalledWith('stored-poultry')
      expect(sendTelegramMessage.mock.calls[0]![1]).toContain('Tap Confirm or Cancel below.')
    })

    it('offers the draft to confirm once the type is answered', async () => {
      applyPoultryTypeAnswer.mockResolvedValue({
        handled: true,
        draftId: 'stored-poultry',
        batchType: 'layer',
      })
      const { tryApplyPoultryTypeAnswer } = await import('./telegram-offer-drafts.js')

      await expect(tryApplyPoultryTypeAnswer(user, 9, 'layer', 'fr')).resolves.toBe(true)

      expect(confirmCancelKeyboard).toHaveBeenCalledWith('stored-poultry')
      expect(sendTelegramMessage.mock.calls[0]![1]).toContain('Type de volaille défini sur layer.')
    })

    it('leaves a message that is not an answer to the butler', async () => {
      applyPoultryTypeAnswer.mockResolvedValue({ handled: false })
      const { tryApplyPoultryTypeAnswer } = await import('./telegram-offer-drafts.js')

      await expect(tryApplyPoultryTypeAnswer(user, 9, 'brief')).resolves.toBe(false)
      expect(sendTelegramMessage).not.toHaveBeenCalled()
    })
  })
})
