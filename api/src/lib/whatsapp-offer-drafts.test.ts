import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CANONICAL_CROP_TYPES } from './crop-normalize.js'
import { isNoilerBatch } from './species-normalize.js'

const sendWhatsAppText = vi.fn(async (_phone: string, _text: string) => undefined)
const prepareCreateTaskDraft = vi.fn()
const prepareCensusDraft = vi.fn()
const prepareCreatePlotDraft = vi.fn()
const prepareLivestockLogDraft = vi.fn()
const prepareVerifyLotDraft = vi.fn()
const applyLotEnrichText = vi.fn()
const storeActionDraft = vi.fn()
const canAssignTasks = vi.fn(() => true)
const resolvePlotByName = vi.fn()
const applyPoultryTypeAnswer = vi.fn()

type CanonicalStub = { english: string; sourceLocale: string; status: 'done' | 'pending' }
type CanonicalArgs = { text: string; farmId: string; sourceLocale?: string | null }
const toCanonicalEnglish = vi.fn(
  async ({ text }: CanonicalArgs): Promise<CanonicalStub> => ({
    english: text,
    sourceLocale: 'en',
    status: 'done',
  }),
)

const updateWhere = vi.fn(async () => undefined)
const updateSet = vi.fn(() => ({ where: updateWhere }))
const update = vi.fn(() => ({ set: updateSet }))

vi.mock('../db/index.js', () => ({
  db: { update },
}))

vi.mock('./content-locale.js', () => ({
  toCanonicalEnglish,
}))

vi.mock('./whatsapp-meta.js', () => ({
  sendWhatsAppText,
}))

// Needed only by the cross-channel test, which drives the Telegram module too.
vi.mock('./telegram.js', () => ({
  sendTelegramMessage: vi.fn(async () => undefined),
  confirmCancelKeyboard: vi.fn(() => ({ inline_keyboard: [] })),
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
  prepareCreatePlotDraft,
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

/** Canonical-English stub: French in, English out, everything else untouched. */
const FRENCH_TO_ENGLISH: Record<string, string> = {
  'Désherber Block 2': 'Weed Block 2',
  'récolte du matin': 'morning harvest',
  'très bonne qualité': 'very good quality',
  'stress thermique': 'heat stress',
}

describe('whatsapp-offer-drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    canAssignTasks.mockReturnValue(true)
    toCanonicalEnglish.mockImplementation(async ({ text }: CanonicalArgs) => ({
      english: FRENCH_TO_ENGLISH[text] ?? text,
      sourceLocale: FRENCH_TO_ENGLISH[text] ? 'fr' : 'en',
      status: 'done',
    }))
  })

  it('exports the confirm hint used in previews', async () => {
    const { WA_CONFIRM_HINT } = await import('./whatsapp-offer-drafts.js')
    expect(WA_CONFIRM_HINT).toMatch(/CONFIRM/i)
    expect(WA_CONFIRM_HINT).toMatch(/CANCEL/i)
  })

  it('offerTaskDraft sends preview + confirm hint on success', async () => {
    prepareCreateTaskDraft.mockResolvedValue({
      ok: true,
      preview: 'Create task: Weed Block 1',
      draftId: 'd1',
    })
    const { offerTaskDraft, WA_CONFIRM_HINT } = await import('./whatsapp-offer-drafts.js')
    await offerTaskDraft(user, '234801', 'Weed Block 1')
    expect(prepareCreateTaskDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        user,
        title: 'Weed Block 1',
        channel: 'whatsapp',
        externalChatId: '234801',
      }),
    )
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      '234801',
      `Create task: Weed Block 1\n\n${WA_CONFIRM_HINT}`,
    )
  })

  it('offerTaskDraft sends prepare error without confirm hint', async () => {
    prepareCreateTaskDraft.mockResolvedValue({ ok: false, error: 'Not allowed' })
    const { offerTaskDraft } = await import('./whatsapp-offer-drafts.js')
    await offerTaskDraft(user, '234801', 'x')
    expect(sendWhatsAppText).toHaveBeenCalledWith('234801', 'Not allowed')
  })

  it('offerCensusDraft appends create-plot hint on not-found errors', async () => {
    prepareCensusDraft.mockResolvedValue({ ok: false, error: 'Plot "North" not found' })
    const { offerCensusDraft } = await import('./whatsapp-offer-drafts.js')
    await offerCensusDraft(user, '234801', {
      plotName: 'North',
      cropType: 'maize',
      count: 10,
    } as never)
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      '234801',
      expect.stringContaining('Create plot: Name zone=ZoneName'),
    )
  })

  it('offerCropCycleDraft rejects non-assigners', async () => {
    canAssignTasks.mockReturnValue(false)
    const { offerCropCycleDraft } = await import('./whatsapp-offer-drafts.js')
    await offerCropCycleDraft(user, '234801', {
      plotName: 'B1',
      cropType: 'tomato',
      plantedAt: '2026-01-01',
    } as never)
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      '234801',
      'Only Admin or Supervisor can create crop cycles.',
    )
    expect(storeActionDraft).not.toHaveBeenCalled()
  })

  it('offerCropCycleDraft stores draft when plot resolves', async () => {
    resolvePlotByName.mockResolvedValue({ id: 'plot-1', name: 'Block 1' })
    storeActionDraft.mockResolvedValue({ id: 'draft-9' })
    const { offerCropCycleDraft, WA_CONFIRM_HINT } = await import('./whatsapp-offer-drafts.js')
    await offerCropCycleDraft(user, '234801', {
      plotName: 'Block 1',
      cropType: 'tomato',
      plantedAt: '2026-01-01',
    } as never)
    expect(storeActionDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'create_crop_cycle',
        channel: 'whatsapp',
        externalChatId: '234801',
      }),
    )
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      '234801',
      expect.stringContaining(WA_CONFIRM_HINT),
    )
  })

  describe('canonical-English normalization', () => {
    it('stores an English task title while previewing the French the worker wrote', async () => {
      prepareCreateTaskDraft.mockImplementation(async ({ title }: { title: string }) => ({
        ok: true,
        preview: `Draft task ready:\nTitle: ${title}`,
        draftId: 'd1',
      }))
      const { offerTaskDraft } = await import('./whatsapp-offer-drafts.js')
      await offerTaskDraft(user, '234801', 'Désherber Block 2', 'fr')

      expect(toCanonicalEnglish).toHaveBeenCalledWith({
        text: 'Désherber Block 2',
        farmId: 'farm-1',
        sourceLocale: 'fr',
      })
      expect(prepareCreateTaskDraft).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Weed Block 2' }),
      )
      const [, reply] = sendWhatsAppText.mock.calls[0]!
      expect(reply).toContain('Désherber Block 2')
      expect(reply).not.toContain('Weed Block 2')
    })

    it('records the source locale and done status on the draft row', async () => {
      prepareCreateTaskDraft.mockResolvedValue({ ok: true, preview: 'Weed Block 2', draftId: 'd1' })
      const { offerTaskDraft } = await import('./whatsapp-offer-drafts.js')
      await offerTaskDraft(user, '234801', 'Désherber Block 2', 'fr')

      expect(update).toHaveBeenCalled()
      expect(updateSet).toHaveBeenCalledWith({ sourceLocale: 'fr', translationStatus: 'done' })
    })

    it('leaves English input untouched and does not mark the draft as translated', async () => {
      prepareCreateTaskDraft.mockImplementation(async ({ title }: { title: string }) => ({
        ok: true,
        preview: `Title: ${title}`,
        draftId: 'd1',
      }))
      const { offerTaskDraft, WA_CONFIRM_HINT } = await import('./whatsapp-offer-drafts.js')
      await offerTaskDraft(user, '234801', 'Weed Block 2', 'en')

      expect(prepareCreateTaskDraft).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Weed Block 2' }),
      )
      expect(update).not.toHaveBeenCalled()
      expect(sendWhatsAppText).toHaveBeenCalledWith(
        '234801',
        `Title: Weed Block 2\n\n${WA_CONFIRM_HINT}`,
      )
    })

    it('persists the original text with pending status when translation is unavailable', async () => {
      toCanonicalEnglish.mockResolvedValue({
        english: 'Stress thermique dans Block 2',
        sourceLocale: 'fr',
        status: 'pending',
      })
      prepareLivestockLogDraft.mockImplementation(async ({ notes }: { notes?: string }) => ({
        ok: true,
        preview: `Draft livestock log ready:\nNotes: ${notes}`,
        draftId: 'd2',
      }))
      const { offerLivestockLogDraft, WA_CONFIRM_HINT } = await import(
        './whatsapp-offer-drafts.js'
      )
      await offerLivestockLogDraft(
        user,
        '234801',
        {
          logType: 'mortality',
          batchQuery: 'Noiler A',
          headCount: 3,
          notes: 'Stress thermique dans Block 2',
        } as never,
        'fr',
      )

      // The worker's own words are stored, flagged for the retry job.
      expect(prepareLivestockLogDraft).toHaveBeenCalledWith(
        expect.objectContaining({ notes: 'Stress thermique dans Block 2' }),
      )
      expect(updateSet).toHaveBeenCalledWith({ sourceLocale: 'fr', translationStatus: 'pending' })
      // …and the worker still gets their draft to confirm.
      expect(sendWhatsAppText).toHaveBeenCalledWith(
        '234801',
        expect.stringContaining(WA_CONFIRM_HINT),
      )
    })

    it('translates livestock log notes but never the batch name', async () => {
      prepareLivestockLogDraft.mockResolvedValue({ ok: true, preview: 'ok', draftId: 'd2' })
      const { offerLivestockLogDraft } = await import('./whatsapp-offer-drafts.js')
      await offerLivestockLogDraft(
        user,
        '234801',
        {
          logType: 'mortality',
          batchQuery: 'Noiler A',
          headCount: 3,
          notes: 'stress thermique',
        } as never,
        'fr',
      )

      expect(prepareLivestockLogDraft).toHaveBeenCalledWith(
        expect.objectContaining({ batchQuery: 'Noiler A', headCount: 3, notes: 'heat stress' }),
      )
      expect(toCanonicalEnglish).toHaveBeenCalledTimes(1)
      expect(toCanonicalEnglish).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'stress thermique' }),
      )
    })

    it('passes plot, zone and lot identifiers through unchanged', async () => {
      prepareCreatePlotDraft.mockResolvedValue({ ok: true, preview: 'ok', draftId: 'd3' })
      prepareVerifyLotDraft.mockResolvedValue({ ok: true, preview: 'ok', draftId: 'd4' })
      const { offerCreatePlotDraft, offerVerifyLotDraft } = await import(
        './whatsapp-offer-drafts.js'
      )

      await offerCreatePlotDraft(
        user,
        '234801',
        { name: 'Block 2', zoneName: 'North Field', cropType: 'plantain' } as never,
        'fr',
      )
      expect(prepareCreatePlotDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Block 2',
          zoneName: 'North Field',
          cropType: 'plantain',
        }),
      )

      await offerVerifyLotDraft(
        user,
        '234801',
        {
          lotCode: 'TRV-LOT-2026-014',
          status: 'verified',
          note: 'très bonne qualité',
        } as never,
        'fr',
      )
      expect(prepareVerifyLotDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          lotCode: 'TRV-LOT-2026-014',
          note: 'very good quality',
        }),
      )
    })

    it('normalizes lot enrich notes but forwards qty lines verbatim', async () => {
      applyLotEnrichText.mockResolvedValue({
        handled: true,
        draftId: 'd5',
        reply: 'Draft public notes saved. Confirm when ready.',
      })
      const { tryApplyLotEnrichText } = await import('./whatsapp-offer-drafts.js')

      await tryApplyLotEnrichText(user, '234801', 'notes récolte du matin', 'fr')
      expect(applyLotEnrichText).toHaveBeenCalledWith(user, 'notes morning harvest')
      expect(updateSet).toHaveBeenCalledWith({ sourceLocale: 'fr', translationStatus: 'done' })

      applyLotEnrichText.mockResolvedValue({ handled: true, draftId: 'd5', reply: 'qty set' })
      toCanonicalEnglish.mockClear()
      await tryApplyLotEnrichText(user, '234801', 'qty 12 crates', 'fr')
      expect(applyLotEnrichText).toHaveBeenLastCalledWith(user, 'qty 12 crates')
      expect(toCanonicalEnglish).not.toHaveBeenCalled()
    })
  })

  describe('crop type is a lookup key, not prose', () => {
    /** The same message a French supervisor sends over either channel. */
    const frenchCropCycle = {
      plotName: 'Block 1',
      cropType: 'banane plantain',
      plantedAt: '2026-01-01',
    }

    beforeEach(() => {
      resolvePlotByName.mockResolvedValue({ id: 'plot-1', name: 'Block 1' })
      storeActionDraft.mockResolvedValue({ id: 'draft-crop' })
    })

    it('keeps cropType out of the translated-field map used by confirm and retry', async () => {
      const { DRAFT_FREE_TEXT_FIELDS } = await import('./draft-canonical.js')
      for (const fields of Object.values(DRAFT_FREE_TEXT_FIELDS)) {
        expect(fields).not.toContain('cropType')
      }
    })

    it('stores the canonical playbook key for a French crop name, with no LLM call', async () => {
      const { offerCropCycleDraft } = await import('./whatsapp-offer-drafts.js')
      await offerCropCycleDraft(user, '234801', frenchCropCycle as never, 'fr')

      const { payload } = storeActionDraft.mock.calls[0]![0]
      expect(payload.cropType).toBe('plantain')
      expect(CANONICAL_CROP_TYPES).toContain(payload.cropType)
      expect(toCanonicalEnglish).not.toHaveBeenCalled()
    })

    it('still shows the worker the words they wrote', async () => {
      const { offerCropCycleDraft } = await import('./whatsapp-offer-drafts.js')
      await offerCropCycleDraft(user, '234801', frenchCropCycle as never, 'fr')

      const [, reply] = sendWhatsAppText.mock.calls[0]!
      expect(reply).toContain('banane plantain')
    })

    it('normalizes the census and plot crop types too', async () => {
      prepareCensusDraft.mockResolvedValue({ ok: true, preview: 'ok', draftId: 'd1' })
      prepareCreatePlotDraft.mockResolvedValue({ ok: true, preview: 'ok', draftId: 'd2' })
      const { offerCensusDraft, offerCreatePlotDraft } = await import(
        './whatsapp-offer-drafts.js'
      )

      await offerCensusDraft(
        user,
        '234801',
        { blockName: 'Block 1', cropType: 'Noix de Coco', plantCount: 40 } as never,
        'fr',
      )
      expect(prepareCensusDraft).toHaveBeenCalledWith(
        expect.objectContaining({ cropType: 'coconut' }),
      )

      await offerCreatePlotDraft(
        user,
        '234801',
        { name: 'Block 2', zoneName: 'North Field', cropType: 'ọgẹdẹ àgbagbà' } as never,
        'yo',
      )
      expect(prepareCreatePlotDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Block 2',
          zoneName: 'North Field',
          cropType: 'plantain',
        }),
      )
      expect(toCanonicalEnglish).not.toHaveBeenCalled()
    })

    it('stores a crop with no playbook exactly as the worker typed it', async () => {
      const { offerCropCycleDraft } = await import('./whatsapp-offer-drafts.js')
      await offerCropCycleDraft(
        user,
        '234801',
        { ...frenchCropCycle, cropType: 'Igname blanche' } as never,
        'fr',
      )

      expect(storeActionDraft.mock.calls[0]![0].payload.cropType).toBe('Igname blanche')
      expect(toCanonicalEnglish).not.toHaveBeenCalled()
    })

    // Regression: the two channels once disagreed about cropType — Telegram left
    // it as typed (no playbook match) and WhatsApp sent it to the translator (any
    // synonym, so maybe no match). Both must now store the same exact key.
    it('stores the same value as the Telegram channel for the same French crop name', async () => {
      const { offerCropCycleDraft: offerOverWhatsApp } = await import(
        './whatsapp-offer-drafts.js'
      )
      const { offerCropCycleDraft: offerOverTelegram } = await import(
        './telegram-offer-drafts.js'
      )

      await offerOverWhatsApp(user, '234801', frenchCropCycle as never, 'fr')
      await offerOverTelegram(user, 42, frenchCropCycle as never)

      const [fromWhatsApp, fromTelegram] = storeActionDraft.mock.calls.map(
        (call) => call[0].payload.cropType,
      )
      expect(storeActionDraft).toHaveBeenCalledTimes(2)
      expect(fromWhatsApp).toBe(fromTelegram)
      expect(fromWhatsApp).toBe('plantain')
      expect(CANONICAL_CROP_TYPES).toContain(fromWhatsApp)
    })
  })

  describe('species is a lookup key, not prose', () => {
    /** The same message a French supervisor sends over either channel. */
    const frenchBatch = {
      name: 'Shed A',
      species: 'poulet noiler',
      headCount: 200,
      acquiredAt: '2026-01-01',
    }

    beforeEach(() => {
      storeActionDraft.mockResolvedValue({ id: 'draft-batch' })
    })

    it('keeps species out of the translated-field map used by confirm and retry', async () => {
      const { DRAFT_FREE_TEXT_FIELDS } = await import('./draft-canonical.js')
      for (const fields of Object.values(DRAFT_FREE_TEXT_FIELDS)) {
        expect(fields).not.toContain('species')
        expect(fields).not.toContain('speciesTyped')
      }
    })

    it('stores the canonical species for a French name, with no LLM call', async () => {
      const { offerLivestockBatchDraft } = await import('./whatsapp-offer-drafts.js')
      await offerLivestockBatchDraft(user, '234801', frenchBatch as never)

      const { payload } = storeActionDraft.mock.calls[0]![0]
      expect(payload.species).toBe('noiler')
      expect(isNoilerBatch({ species: payload.species as string })).toBe(true)
      expect(toCanonicalEnglish).not.toHaveBeenCalled()
    })

    it('still shows the worker the words they wrote', async () => {
      const { offerLivestockBatchDraft } = await import('./whatsapp-offer-drafts.js')
      await offerLivestockBatchDraft(user, '234801', frenchBatch as never)

      const [, reply] = sendWhatsAppText.mock.calls[0]!
      expect(reply).toContain('poulet noiler')
      expect(storeActionDraft.mock.calls[0]![0].payload.speciesTyped).toBe('poulet noiler')
    })

    it('stores a species the enum cannot express exactly as the worker typed it', async () => {
      const { offerLivestockBatchDraft } = await import('./whatsapp-offer-drafts.js')
      await offerLivestockBatchDraft(
        user,
        '234801',
        { ...frenchBatch, species: 'Kuroiler cockerel' } as never,
      )

      expect(storeActionDraft.mock.calls[0]![0].payload.species).toBe('Kuroiler cockerel')
      expect(toCanonicalEnglish).not.toHaveBeenCalled()
    })

    // Same regression as cropType: the two channels must not disagree about the
    // value that gates the vaccination schedule and the noiler playbook.
    it('stores the same value as the Telegram channel for the same French species', async () => {
      const { offerLivestockBatchDraft: offerOverWhatsApp } = await import(
        './whatsapp-offer-drafts.js'
      )
      const { offerLivestockBatchDraft: offerOverTelegram } = await import(
        './telegram-offer-drafts.js'
      )

      await offerOverWhatsApp(user, '234801', frenchBatch as never)
      await offerOverTelegram(user, 42, frenchBatch as never)

      const [fromWhatsApp, fromTelegram] = storeActionDraft.mock.calls.map(
        (call) => call[0].payload.species,
      )
      expect(storeActionDraft).toHaveBeenCalledTimes(2)
      expect(fromWhatsApp).toBe(fromTelegram)
      expect(isNoilerBatch({ species: fromWhatsApp as string })).toBe(true)
    })
  })

  describe('the poultry type the worker did not say', () => {
    const batch = {
      name: 'Shed A',
      species: 'poulet',
      headCount: 200,
      acquiredAt: '2026-01-01',
    }

    beforeEach(() => {
      storeActionDraft.mockResolvedValue({ id: 'draft-poultry' })
    })

    it('asks which type instead of offering the draft to confirm', async () => {
      const { offerLivestockBatchDraft } = await import('./whatsapp-offer-drafts.js')
      await offerLivestockBatchDraft(user, '234801', batch as never)

      expect(storeActionDraft.mock.calls[0]![0].payload.awaitingBatchType).toBe(true)
      const [, reply] = sendWhatsAppText.mock.calls[0]!
      expect(reply).toContain('noiler | layer | pullet | other')
      expect(reply).not.toContain('CONFIRM')
    })

    it('asks in the worker\u2019s own language', async () => {
      const { offerLivestockBatchDraft } = await import('./whatsapp-offer-drafts.js')
      await offerLivestockBatchDraft(user, '234801', batch as never, 'pcm')

      expect(sendWhatsAppText.mock.calls[0]![1]).toContain('I no fit sabi which kind poultry')
    })

    it('does not ask when the words already name a type', async () => {
      const { offerLivestockBatchDraft, WA_CONFIRM_HINT } = await import(
        './whatsapp-offer-drafts.js'
      )
      await offerLivestockBatchDraft(user, '234801', { ...batch, species: 'pondeuses' } as never)

      expect(storeActionDraft.mock.calls[0]![0].payload.awaitingBatchType).toBe(false)
      expect(sendWhatsAppText.mock.calls[0]![1]).toContain(WA_CONFIRM_HINT)
    })

    it('offers the draft to confirm once the type is answered', async () => {
      applyPoultryTypeAnswer.mockResolvedValue({
        handled: true,
        draftId: 'draft-poultry',
        batchType: 'noiler',
      })
      const { tryApplyPoultryTypeAnswer, WA_CONFIRM_HINT } = await import(
        './whatsapp-offer-drafts.js'
      )

      await expect(tryApplyPoultryTypeAnswer(user, '234801', 'noiler', 'yo')).resolves.toBe(true)

      const [, reply] = sendWhatsAppText.mock.calls[0]!
      expect(reply).toContain('Irú adìẹ ti di noiler.')
      expect(reply).toContain(WA_CONFIRM_HINT)
    })

    it('leaves a message that is not an answer to the butler', async () => {
      applyPoultryTypeAnswer.mockResolvedValue({ handled: false })
      const { tryApplyPoultryTypeAnswer } = await import('./whatsapp-offer-drafts.js')

      await expect(tryApplyPoultryTypeAnswer(user, '234801', 'brief')).resolves.toBe(false)
      expect(sendWhatsAppText).not.toHaveBeenCalled()
    })
  })
})
