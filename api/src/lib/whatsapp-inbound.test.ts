import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendWhatsAppText = vi.fn(async () => undefined)
const tryHandleWhatsAppDraftConfirm = vi.fn(async () => false)
const checkButlerRateLimit = vi.fn(() => true)
const recordChatMessage = vi.fn(async () => undefined)
const answerText = vi.fn(async () => 'reply')
const deliverButlerReply = vi.fn(async () => undefined)
const transcribeVoice = vi.fn(async (): Promise<string | null> => null)
const offerTaskDraft = vi.fn(async () => undefined)
const parseCreateTaskIntent = vi.fn((): { title: string } | null => null)
const looksUrgent = vi.fn((_text: string) => false)
const notifyWorkerAlertChannels = vi.fn(async () => undefined)
const downloadWhatsAppMediaBuffer = vi.fn(async () => ({
  buffer: Buffer.from('x'),
  filename: 'a.ogg',
}))
const attachPhotoToLotEnrichDraft = vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: false }))

type CanonicalStub = { english: string; sourceLocale: string; status: 'done' | 'pending' }
type CanonicalArgs = { text: string; farmId: string; sourceLocale?: string | null }
const toCanonicalEnglish = vi.fn(
  async ({ text }: CanonicalArgs): Promise<CanonicalStub> => ({
    english: text,
    sourceLocale: 'en',
    status: 'done',
  }),
)
const selectWhere = vi.fn()
const selectFrom = vi.fn(() => ({ where: selectWhere }))
const select = vi.fn(() => ({ from: selectFrom }))

vi.mock('../db/index.js', () => ({
  db: { select },
}))

vi.mock('./whatsapp-meta.js', () => ({
  sendWhatsAppText,
  sendWhatsAppImage: vi.fn(),
  downloadWhatsAppMedia: vi.fn(),
  downloadWhatsAppMediaBuffer,
}))

// `authorLocaleHint` is the real one on purpose: it is a pure function carrying
// the rule that a default 'en' preference is not evidence the worker writes in
// English. A local copy here would let this test keep passing after that rule
// changed.
vi.mock('./content-locale.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./content-locale.js')>()),
  toCanonicalEnglish,
}))

vi.mock('./whatsapp-draft-confirm.js', () => ({
  tryHandleWhatsAppDraftConfirm,
  draftConfirmHint: (locale?: string | null) =>
    locale === 'fr' ? 'Répondez CONFIRMER pour enregistrer, ou ANNULER.' : 'Reply CONFIRM to save, or CANCEL.',
}))

vi.mock('./whatsapp-offer-drafts.js', () => ({
  offerTaskDraft,
  offerCensusDraft: vi.fn(),
  offerAssetCountDraft: vi.fn(),
  offerCropCycleDraft: vi.fn(),
  offerLivestockBatchDraft: vi.fn(),
  offerStockMoveDraft: vi.fn(),
  offerOpeningCountDraft: vi.fn(),
  offerLowStockAckDraft: vi.fn(),
  offerCreateZoneDraft: vi.fn(),
  offerCreatePlotDraft: vi.fn(),
  offerLivestockLogDraft: vi.fn(),
  offerLotEnrichDraft: vi.fn(),
  offerVerifyLotDraft: vi.fn(),
  tryApplyLotEnrichText: vi.fn(async () => false),
  tryApplyPoultryTypeAnswer: vi.fn(async () => false),
}))

vi.mock('./butler-rate-limit.js', () => ({
  checkButlerRateLimit,
}))

vi.mock('./butler-core.js', () => ({
  answerText,
  answerPhoto: vi.fn(),
  recordChatMessage,
  transcribeVoice,
}))

vi.mock('./butler-reply.js', () => ({
  deliverButlerReply,
}))

vi.mock('./farm-notify.js', () => ({
  looksUrgent,
  notifyWorkerAlertChannels,
}))

const tryHandleStaffOpsCommand = vi.fn(
  async (_params: {
    text: string
    noteLocale?: { sourceLocale?: string | null; translationStatus?: string }
  }): Promise<{ handled: boolean; reply?: string }> => ({ handled: false }),
)

vi.mock('./staff-ops.js', () => ({
  tryHandleStaffOpsCommand,
}))

vi.mock('./order-fulfillment.js', () => ({
  tryHandleStaffOrderCommand: vi.fn(async () => ({ handled: false })),
  setUserPreferredLocale: vi.fn(),
}))

vi.mock('./role-menus.js', () => ({
  roleCommandHelp: () => 'help',
}))

vi.mock('./order-messages.js', () => ({
  staffLocale: () => 'en',
  languagePromptMessage: () => 'pick language',
  languageSavedMessage: () => 'saved',
  orderCommandHelp: () => 'orders',
}))

vi.mock('./action-draft-ops.js', () => ({
  parseCreateTaskIntent,
  parseCensusIntent: vi.fn(() => null),
  parseAssetCountIntent: vi.fn(() => null),
}))

vi.mock('./action-draft-farm.js', () => ({
  parseCropCycleIntent: vi.fn(() => null),
  parseLivestockBatchIntent: vi.fn(() => null),
}))

vi.mock('./action-draft-inventory.js', () => ({
  parseStockMoveIntent: vi.fn(() => null),
  parseOpeningCountIntent: vi.fn(() => null),
  parseLowStockAckIntent: vi.fn(() => null),
}))

vi.mock('./action-draft-zones.js', () => ({
  parseCreateZoneIntent: vi.fn(() => null),
  parseCreatePlotIntent: vi.fn(() => null),
}))

vi.mock('./action-draft-livestock-log.js', () => ({
  parseLivestockLogIntent: vi.fn(() => null),
}))

vi.mock('./lot-enrich.js', () => ({
  parseVerifyLotIntent: vi.fn(() => null),
  attachPhotoToLotEnrichDraft,
  formatLotsToPackMessage: vi.fn(),
}))

vi.mock('./lot-print.js', () => ({
  buildLotQrPng: vi.fn(),
  findPrintableLotByCode: vi.fn(),
  listRecentPrintableLots: vi.fn(),
}))

vi.mock('./handover-templates.js', () => ({
  getHandoverProgress: vi.fn(),
  formatHandoverProgressText: vi.fn(),
}))

vi.mock('./evidence-store.js', () => ({
  processEvidenceValue: vi.fn(),
}))

vi.mock('./rbac.js', () => ({
  canManageOrders: () => true,
}))

vi.mock('./reply-locale.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./reply-locale.js')>()),
  voiceNotUnderstoodMessage: () => 'sorry',
}))

const linkedUser = {
  id: 'user-1',
  farmId: 'farm-1',
  email: 'a@b.com',
  name: 'Ada',
  role: 'owner',
  phone: '+2348012345678',
  active: true,
  mustChangePassword: false,
  preferredLocale: 'en',
}

function textPayload(from: string, body: string) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from,
                  id: 'wamid.1',
                  timestamp: '1',
                  type: 'text',
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  }
}

describe('handleInboundWhatsApp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkButlerRateLimit.mockReturnValue(true)
    tryHandleWhatsAppDraftConfirm.mockResolvedValue(false)
    tryHandleStaffOpsCommand.mockResolvedValue({ handled: false })
    selectWhere.mockResolvedValue([])
    answerText.mockResolvedValue('reply')
    looksUrgent.mockReturnValue(false)
    parseCreateTaskIntent.mockReturnValue(null)
    transcribeVoice.mockResolvedValue(null)
    attachPhotoToLotEnrichDraft.mockResolvedValue({ ok: false })
    toCanonicalEnglish.mockImplementation(async ({ text }: CanonicalArgs) => ({
      english: text,
      sourceLocale: 'en',
      status: 'done',
    }))
  })

  it('tells a French worker which keyword to send after a lot photo lands', async () => {
    selectWhere.mockResolvedValue([{ ...linkedUser, preferredLocale: 'fr' }])
    attachPhotoToLotEnrichDraft.mockResolvedValue({ ok: true })
    const { handleInboundWhatsApp } = await import('./whatsapp-inbound.js')
    await handleInboundWhatsApp({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: '2348012345678',
                    id: 'wamid.photo',
                    timestamp: '1',
                    type: 'image',
                    image: { id: 'media-9' },
                  },
                ],
              },
            },
          ],
        },
      ],
    })

    expect(sendWhatsAppText).toHaveBeenCalledWith(
      '2348012345678',
      expect.stringContaining('CONFIRMER'),
    )
  })

  it('returns handled 0 for empty payloads', async () => {
    const { handleInboundWhatsApp } = await import('./whatsapp-inbound.js')
    await expect(handleInboundWhatsApp({})).resolves.toEqual({ handled: 0 })
    await expect(handleInboundWhatsApp({ entry: [] })).resolves.toEqual({ handled: 0 })
  })

  it('skips unknown phones without counting as handled', async () => {
    selectWhere.mockResolvedValue([])
    const { handleInboundWhatsApp } = await import('./whatsapp-inbound.js')
    const result = await handleInboundWhatsApp(textPayload('2348099999999', 'hello'))
    expect(result).toEqual({ handled: 0 })
    expect(tryHandleWhatsAppDraftConfirm).not.toHaveBeenCalled()
  })

  it('routes linked text through draft-confirm first', async () => {
    selectWhere.mockResolvedValue([linkedUser])
    tryHandleWhatsAppDraftConfirm.mockResolvedValue(true)
    const { handleInboundWhatsApp } = await import('./whatsapp-inbound.js')
    const result = await handleInboundWhatsApp(textPayload('2348012345678', 'CONFIRM'))
    expect(result).toEqual({ handled: 1 })
    expect(tryHandleWhatsAppDraftConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      '2348012345678',
      'CONFIRM',
      'en',
    )
  })

  it('hands the worker locale to draft-confirm so CONFIRMER is understood', async () => {
    selectWhere.mockResolvedValue([{ ...linkedUser, preferredLocale: 'fr' }])
    tryHandleWhatsAppDraftConfirm.mockResolvedValue(true)
    const { handleInboundWhatsApp } = await import('./whatsapp-inbound.js')
    await handleInboundWhatsApp(textPayload('2348012345678', 'CONFIRMER'))

    expect(tryHandleWhatsAppDraftConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      '2348012345678',
      'CONFIRMER',
      'fr',
    )
    // Nothing else in the pipeline saw it.
    expect(answerText).not.toHaveBeenCalled()
  })

  it('replies with language prompt for language command', async () => {
    selectWhere.mockResolvedValue([linkedUser])
    const { handleInboundWhatsApp } = await import('./whatsapp-inbound.js')
    await handleInboundWhatsApp(textPayload('2348012345678', 'language'))
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      '2348012345678',
      expect.stringContaining('lang en'),
    )
  })

  it('tells user unsupported media types', async () => {
    selectWhere.mockResolvedValue([linkedUser])
    const { handleInboundWhatsApp } = await import('./whatsapp-inbound.js')
    await handleInboundWhatsApp({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: '2348012345678',
                    id: 'wamid.2',
                    timestamp: '1',
                    type: 'sticker',
                  },
                ],
              },
            },
          ],
        },
      ],
    })
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      '2348012345678',
      expect.stringContaining('text, voice notes and photos'),
    )
  })

  describe('canonical-English storage', () => {
    const frenchWorker = { ...linkedUser, role: 'field_worker', preferredLocale: 'fr' }

    function audioPayload(from: string) {
      return {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      from,
                      id: 'wamid.voice',
                      timestamp: '1',
                      type: 'audio',
                      audio: { id: 'media-1', voice: true },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }
    }

    it('logs English for a French message while replying in French', async () => {
      selectWhere.mockResolvedValue([frenchWorker])
      toCanonicalEnglish.mockResolvedValue({
        english: '5 chickens died in Block 2',
        sourceLocale: 'fr',
        status: 'done',
      })
      answerText.mockResolvedValue('Cinq poulets sont morts — voici quoi faire.')
      const { handleInboundWhatsApp } = await import('./whatsapp-inbound.js')
      await handleInboundWhatsApp(
        textPayload('2348012345678', '5 poulets sont morts dans Block 2'),
      )

      expect(toCanonicalEnglish).toHaveBeenCalledWith({
        text: '5 poulets sont morts dans Block 2',
        farmId: 'farm-1',
        sourceLocale: 'fr',
      })
      expect(recordChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '5 chickens died in Block 2',
          extra: {
            sourceLocale: 'fr',
            translationStatus: 'done',
            originalText: '5 poulets sont morts dans Block 2',
          },
        }),
      )
      // The butler still reads and answers the worker's own words.
      expect(answerText).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        '5 poulets sont morts dans Block 2',
        'whatsapp_message',
        'fr',
      )
      expect(deliverButlerReply).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Cinq poulets sont morts — voici quoi faire.' }),
      )
    })

    it('logs English input unchanged and without an original-text copy', async () => {
      selectWhere.mockResolvedValue([linkedUser])
      const { handleInboundWhatsApp } = await import('./whatsapp-inbound.js')
      await handleInboundWhatsApp(textPayload('2348012345678', 'Two crates harvested'))

      expect(recordChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Two crates harvested',
          extra: { sourceLocale: 'en', translationStatus: 'done' },
        }),
      )
    })

    it('logs the original text as pending when translation is unavailable', async () => {
      selectWhere.mockResolvedValue([frenchWorker])
      toCanonicalEnglish.mockResolvedValue({
        english: 'Deux caisses récoltées',
        sourceLocale: 'fr',
        status: 'pending',
      })
      const { handleInboundWhatsApp } = await import('./whatsapp-inbound.js')
      await handleInboundWhatsApp(textPayload('2348012345678', 'Deux caisses récoltées'))

      expect(recordChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Deux caisses récoltées',
          extra: { sourceLocale: 'fr', translationStatus: 'pending' },
        }),
      )
      // A translation outage must not stop the worker being answered.
      expect(deliverButlerReply).toHaveBeenCalled()
    })

    it('normalizes a voice transcript once and routes the spoken words onward', async () => {
      selectWhere.mockResolvedValue([frenchWorker])
      transcribeVoice.mockResolvedValue('trois poulets sont malades')
      toCanonicalEnglish.mockResolvedValue({
        english: 'three chickens are sick',
        sourceLocale: 'fr',
        status: 'done',
      })
      const { handleInboundWhatsApp } = await import('./whatsapp-inbound.js')
      await handleInboundWhatsApp(audioPayload('2348012345678'))

      expect(toCanonicalEnglish).toHaveBeenCalledTimes(1)
      expect(recordChatMessage).toHaveBeenCalledTimes(1)
      expect(recordChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'three chickens are sick',
          extra: {
            kind: 'voice',
            sourceLocale: 'fr',
            translationStatus: 'done',
            originalText: 'trois poulets sont malades',
          },
        }),
      )
      expect(answerText).toHaveBeenCalledWith(
        expect.anything(),
        'trois poulets sont malades',
        'whatsapp_message',
        'fr',
      )
    })

    it('hands the author locale to the draft flow without logging or translating', async () => {
      selectWhere.mockResolvedValue([frenchWorker])
      parseCreateTaskIntent.mockReturnValue({ title: 'Désherber Block 2' })
      const { handleInboundWhatsApp } = await import('./whatsapp-inbound.js')
      await handleInboundWhatsApp(
        textPayload('2348012345678', 'task: Désherber Block 2'),
      )

      expect(offerTaskDraft).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        '2348012345678',
        'Désherber Block 2',
        'fr',
      )
      // Draft creation owns the single normalization point for that text.
      expect(toCanonicalEnglish).not.toHaveBeenCalled()
      expect(recordChatMessage).not.toHaveBeenCalled()
    })

    it('matches urgency on the English text and alerts supervisors in English', async () => {
      selectWhere.mockResolvedValue([frenchWorker])
      toCanonicalEnglish.mockResolvedValue({
        english: '5 chickens died in Block 2',
        sourceLocale: 'fr',
        status: 'done',
      })
      looksUrgent.mockImplementation((text: string) => /died/.test(text))
      const { handleInboundWhatsApp } = await import('./whatsapp-inbound.js')
      await handleInboundWhatsApp(
        textPayload('2348012345678', '5 poulets sont morts dans Block 2'),
      )

      expect(looksUrgent).toHaveBeenCalledWith('5 chickens died in Block 2')
      expect(notifyWorkerAlertChannels).toHaveBeenCalledWith(
        'farm-1',
        expect.stringContaining('5 chickens died in Block 2'),
        expect.objectContaining({ reason: 'urgent_keyword' }),
      )
    })

    it('passes noteLocale into staff-ops for a French done note', async () => {
      selectWhere.mockResolvedValue([frenchWorker])
      toCanonicalEnglish.mockResolvedValue({
        english: 'finished picking, two crates left',
        sourceLocale: 'fr',
        status: 'done',
      })
      tryHandleStaffOpsCommand.mockImplementation(async ({ text }: { text: string }) => ({
        handled: true,
        reply: `✅ done\nNote: ${text.replace(/^done TSK-A1B2C3\s+/, '')}`,
      }))
      const { handleInboundWhatsApp } = await import('./whatsapp-inbound.js')

      await handleInboundWhatsApp(
        textPayload(
          '2348012345678',
          'done TSK-A1B2C3 fini de cueillir, deux caisses restent',
        ),
      )

      expect(tryHandleStaffOpsCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'done TSK-A1B2C3 finished picking, two crates left',
          noteLocale: { sourceLocale: 'fr', translationStatus: 'done' },
        }),
      )
      expect(sendWhatsAppText).toHaveBeenCalledWith(
        '2348012345678',
        expect.stringContaining('fini de cueillir, deux caisses restent'),
      )
    })
  })
})
