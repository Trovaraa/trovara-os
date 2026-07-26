import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleCallbackQuery = vi.fn(async () => undefined)
const answerTelegramCallbackQuery = vi.fn(async () => undefined)
const resolveActiveTelegramLink = vi.fn()
const wasTelegramUpdateProcessed = vi.fn(async () => false)
const markTelegramUpdateProcessed = vi.fn(async () => true)
const sendTelegramMessage = vi.fn(async () => undefined)
const downloadTelegramFileBuffer = vi.fn(async () => ({
  buffer: Buffer.from('audio'),
  filename: 'voice.ogg',
}))
const toCanonicalEnglish = vi.fn()
const offerTaskDraft = vi.fn()

type CommandResult = {
  handled: boolean
  reply?: string
  replyMarkup?: Record<string, unknown>
}

const tryHandleStaffOpsCommand = vi.fn(
  async (_params: { text: string }): Promise<CommandResult> => ({ handled: false }),
)
const tryHandleStaffOrderCommand = vi.fn(
  async (_params: { text: string }): Promise<CommandResult> => ({ handled: false }),
)
const parseCreateTaskIntent = vi.fn((_text: string): { title: string } | null => null)
const recordChatMessage = vi.fn(async () => undefined)
const answerText = vi.fn(async () => 'reply')
const transcribeVoice = vi.fn()
const deliverButlerReply = vi.fn(async () => undefined)
const notifyWorkerAlertChannels = vi.fn(async () => undefined)
const looksUrgent = vi.fn(() => false)

vi.mock('./telegram-callbacks.js', () => ({
  handleCallbackQuery,
  deliverPrintQr: vi.fn(),
}))

vi.mock('./telegram.js', () => ({
  sendTelegramMessage,
  getTelegramUpdates: vi.fn(async () => []),
  answerTelegramCallbackQuery,
  downloadTelegramFileBuffer,
  downloadTelegramFile: vi.fn(),
  setTelegramCommandsForChat: vi.fn(),
  confirmCancelKeyboard: vi.fn(),
  startTelegramPollLoop: vi.fn(),
}))

vi.mock('./content-locale.js', () => ({
  toCanonicalEnglish,
  // Real behaviour: the default 'en' preference is dropped so the language is
  // detected from the text instead of being asserted as English.
  authorLocaleHint: (preferred?: string | null) =>
    !preferred || preferred === 'en' ? null : preferred,
}))

vi.mock('./butler-link-codes.js', () => ({
  resolveActiveTelegramLink,
  verifyAndConsumeLinkCode: vi.fn(),
  extractButlerLinkCode: vi.fn(() => null),
}))

vi.mock('./task-drafts.js', () => ({
  markTelegramUpdateProcessed,
  wasTelegramUpdateProcessed,
}))

vi.mock('./telegram-offer-drafts.js', () => ({
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

vi.mock('../db/index.js', () => ({
  db: { select: vi.fn() },
}))

vi.mock('./butler-core.js', () => ({
  answerText,
  answerPhoto: vi.fn(),
  recordChatMessage,
  transcribeVoice,
  downloadTelegramFile: vi.fn(),
}))
vi.mock('./butler-reply.js', () => ({
  deliverButlerReply,
  handleTelegramVoiceCommand: vi.fn(async () => false),
}))
vi.mock('./butler-rate-limit.js', () => ({
  checkButlerRateLimit: vi.fn(() => true),
  checkButlerChatRateLimit: vi.fn(() => true),
}))
vi.mock('./farm-notify.js', () => ({ looksUrgent, notifyWorkerAlertChannels }))
vi.mock('./staff-ops.js', () => ({ tryHandleStaffOpsCommand }))
vi.mock('./order-fulfillment.js', () => ({
  tryHandleStaffOrderCommand,
  setUserPreferredLocale: vi.fn(),
  languageKeyboard: vi.fn(),
}))
vi.mock('./rbac.js', () => ({ canManageOrders: () => true, canAssignTasks: () => true }))
vi.mock('./role-menus.js', () => ({ roleCommandHelp: () => 'help' }))
vi.mock('./order-messages.js', () => ({
  staffLocale: () => 'en',
  languagePromptMessage: () => 'lang',
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
vi.mock('./action-draft-livestock-log.js', () => ({ parseLivestockLogIntent: vi.fn(() => null) }))
vi.mock('./lot-enrich.js', () => ({
  parseVerifyLotIntent: vi.fn(() => null),
  attachPhotoToLotEnrichDraft: vi.fn(),
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
vi.mock('./evidence-store.js', () => ({ processEvidenceValue: vi.fn() }))
vi.mock('./reply-locale.js', () => ({ voiceNotUnderstoodMessage: () => 'sorry' }))
vi.mock('./telegram-config.js', () => ({
  isTelegramConfigured: () => false,
  telegramBotToken: () => '',
}))

function linkedUser(preferredLocale: string | null) {
  resolveActiveTelegramLink.mockResolvedValue({
    id: 'user-1',
    farmId: 'farm-1',
    email: 'a@b.com',
    name: 'Amadou Diallo',
    role: 'field_worker',
    preferredLocale,
    mustChangePassword: false,
    active: true,
  })
}

async function sendText(text: string, updateId = 100) {
  const { handleTelegramUpdate } = await import('./telegram-inbound.js')
  await handleTelegramUpdate({
    update_id: updateId,
    message: { message_id: 7, chat: { id: 99 }, text },
  } as never)
}

async function sendVoice(updateId = 200) {
  const { handleTelegramUpdate } = await import('./telegram-inbound.js')
  await handleTelegramUpdate({
    update_id: updateId,
    message: { message_id: 8, chat: { id: 99 }, voice: { file_id: 'voice-1' } },
  } as never)
}

describe('handleTelegramUpdate routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wasTelegramUpdateProcessed.mockResolvedValue(false)
    markTelegramUpdateProcessed.mockResolvedValue(true)
  })

  it('routes linked callback_query to handleCallbackQuery', async () => {
    resolveActiveTelegramLink.mockResolvedValue({
      id: 'user-1',
      farmId: 'farm-1',
      email: 'a@b.com',
      name: 'Ada',
      role: 'owner',
      preferredLocale: 'en',
      mustChangePassword: false,
      active: true,
    })
    const { handleTelegramUpdate } = await import('./telegram-inbound.js')
    await handleTelegramUpdate({
      update_id: 1,
      callback_query: {
        id: 'cb-1',
        data: 'cancel:draft-1',
        from: { id: 99 },
        message: { chat: { id: 99 } },
      },
    } as never)

    expect(handleCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      expect.objectContaining({ id: 'cb-1' }),
    )
  })

  it('prompts to link when callback has no linked user', async () => {
    resolveActiveTelegramLink.mockResolvedValue(null)
    const { handleTelegramUpdate } = await import('./telegram-inbound.js')
    await handleTelegramUpdate({
      update_id: 2,
      callback_query: {
        id: 'cb-2',
        data: 'cancel:draft-1',
        message: { chat: { id: 55 } },
      },
    } as never)
    expect(answerTelegramCallbackQuery).toHaveBeenCalledWith('cb-2', 'Link your account first.')
    expect(handleCallbackQuery).not.toHaveBeenCalled()
  })

  it('skips already-processed updates', async () => {
    wasTelegramUpdateProcessed.mockResolvedValue(true)
    const { handleTelegramUpdate } = await import('./telegram-inbound.js')
    await handleTelegramUpdate({
      update_id: 3,
      callback_query: { id: 'cb-3', data: 'x', message: { chat: { id: 1 } } },
    } as never)
    expect(markTelegramUpdateProcessed).not.toHaveBeenCalled()
    expect(handleCallbackQuery).not.toHaveBeenCalled()
  })
})

describe('canonical English on inbound Telegram text', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wasTelegramUpdateProcessed.mockResolvedValue(false)
    markTelegramUpdateProcessed.mockResolvedValue(true)
    tryHandleStaffOpsCommand.mockResolvedValue({ handled: false })
    tryHandleStaffOrderCommand.mockResolvedValue({ handled: false })
    parseCreateTaskIntent.mockReturnValue(null)
    looksUrgent.mockReturnValue(false)
    answerText.mockResolvedValue('reply')
    toCanonicalEnglish.mockImplementation(async ({ text }: { text: string }) => ({
      english: text,
      sourceLocale: 'en',
      status: 'done',
    }))
  })

  it('logs a French message in English but answers the worker in French', async () => {
    linkedUser('fr')
    toCanonicalEnglish.mockResolvedValue({
      english: 'Three chickens are sick in Bloc A',
      sourceLocale: 'fr',
      status: 'done',
    })
    answerText.mockResolvedValue('Isolez les poulets malades tout de suite.')

    await sendText('Trois poulets sont malades au Bloc A', 101)

    expect(recordChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Three chickens are sick in Bloc A',
        extra: { sourceLocale: 'fr', translationStatus: 'done' },
      }),
    )
    // The Butler answers the worker's own words, in the worker's language.
    expect(answerText).toHaveBeenCalledWith(
      expect.anything(),
      'Trois poulets sont malades au Bloc A',
      'telegram_message',
      'fr',
    )
    expect(deliverButlerReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Isolez les poulets malades tout de suite.' }),
    )
  })

  it('quotes the English text in the supervisor alert for an urgent French report', async () => {
    linkedUser('fr')
    looksUrgent.mockReturnValue(true)
    toCanonicalEnglish.mockResolvedValue({
      english: 'Fire in the store, come quickly',
      sourceLocale: 'fr',
      status: 'done',
    })

    await sendText('Le feu dans le magasin, venez vite', 102)

    // Urgency keywords are English, so detection runs on the canonical text.
    expect(looksUrgent).toHaveBeenCalledWith('Fire in the store, come quickly')
    expect(notifyWorkerAlertChannels).toHaveBeenCalledWith(
      'farm-1',
      expect.stringContaining('Fire in the store, come quickly'),
      expect.anything(),
    )
  })

  it('stores an English message unchanged', async () => {
    linkedUser('en')

    await sendText('Three chickens are sick in Block A', 103)

    expect(recordChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Three chickens are sick in Block A',
        extra: { sourceLocale: 'en', translationStatus: 'done' },
      }),
    )
  })

  it('persists a pending translation with the original text and still replies', async () => {
    linkedUser('fr')
    toCanonicalEnglish.mockResolvedValue({
      english: 'Trois poulets sont malades',
      sourceLocale: 'fr',
      status: 'pending',
    })
    answerText.mockResolvedValue('Bien reçu.')

    await sendText('Trois poulets sont malades', 104)

    expect(recordChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Trois poulets sont malades',
        extra: { sourceLocale: 'fr', translationStatus: 'pending' },
      }),
    )
    expect(deliverButlerReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Bien reçu.' }),
    )
  })

  it('translates a French voice transcript before persisting it, once', async () => {
    linkedUser('fr')
    transcribeVoice.mockResolvedValue('Récolte terminée au Bloc A')
    toCanonicalEnglish.mockResolvedValue({
      english: 'Harvest finished in Bloc A',
      sourceLocale: 'fr',
      status: 'done',
    })
    answerText.mockResolvedValue('Merci, bien noté.')

    await sendVoice(105)

    expect(recordChatMessage).toHaveBeenCalledTimes(1)
    expect(recordChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Harvest finished in Bloc A',
        extra: { kind: 'voice', sourceLocale: 'fr', translationStatus: 'done' },
      }),
    )
    // The transcript is normalized once and reused by the rest of the flow.
    expect(toCanonicalEnglish).toHaveBeenCalledTimes(1)
    expect(deliverButlerReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '🗣️ "Récolte terminée au Bloc A"\n\nMerci, bien noté.',
      }),
    )
  })

  it('passes a French task title to the draft offer with the author locale', async () => {
    linkedUser('fr')
    parseCreateTaskIntent.mockReturnValue({ title: 'Récolter les bananes au Bloc A' })

    await sendText('Task: Récolter les bananes au Bloc A', 106)

    expect(offerTaskDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      99,
      'Récolter les bananes au Bloc A',
      undefined,
      'fr',
    )
    // Draft normalization happens in telegram-offer-drafts, not here.
    expect(toCanonicalEnglish).not.toHaveBeenCalled()
    expect(recordChatMessage).not.toHaveBeenCalled()
  })

  // Telegram confirms drafts with the inline keyboard, so a typed keyword is
  // ordinary chat here and must reach the butler in every language.
  it.each([
    ['CONFIRM', 201],
    ['CONFIRMER', 202],
    ['JẸ́RÌÍ', 203],
    ['ANNULER', 204],
  ] as const)(
    'sends a typed %s to the butler instead of resolving a draft',
    async (word, updateId) => {
      linkedUser('fr')
      answerText.mockResolvedValue('Utilisez les boutons Confirmer / Annuler.')

      await sendText(word, updateId)

      expect(answerText).toHaveBeenCalledWith(
        expect.anything(),
        word,
        'telegram_message',
        'fr',
      )
      expect(deliverButlerReply).toHaveBeenCalled()
    },
  )

  it('leaves an order code command untouched', async () => {
    linkedUser('fr')
    tryHandleStaffOrderCommand.mockResolvedValue({ handled: true, reply: 'Commande livrée.' })

    await sendText('delivered TRV-ORD-2026-014', 107)

    expect(toCanonicalEnglish).not.toHaveBeenCalled()
    expect(tryHandleStaffOrderCommand).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'delivered TRV-ORD-2026-014' }),
    )
    expect(sendTelegramMessage).toHaveBeenCalledWith(99, 'Commande livrée.', expect.anything())
  })

  it('stores a French task completion note in English and echoes it back in French', async () => {
    linkedUser('fr')
    toCanonicalEnglish.mockResolvedValue({
      english: 'finished picking, two crates left in the shed',
      sourceLocale: 'fr',
      status: 'done',
    })
    tryHandleStaffOpsCommand.mockImplementation(async ({ text }: { text: string }) => ({
      handled: true,
      reply: `✅ TSK-A1B2C3 → completed\nNote : ${text.replace(/^done TSK-A1B2C3\s+/, '')}`,
    }))

    await sendText('done TSK-A1B2C3 fini de cueillir, deux caisses restent au hangar', 108)

    expect(tryHandleStaffOpsCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'done TSK-A1B2C3 finished picking, two crates left in the shed',
        noteLocale: { sourceLocale: 'fr', translationStatus: 'done' },
      }),
    )
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      99,
      '✅ TSK-A1B2C3 → completed\nNote : fini de cueillir, deux caisses restent au hangar',
      expect.anything(),
    )
  })

  it('passes pending noteLocale when translation is unavailable', async () => {
    linkedUser('fr')
    toCanonicalEnglish.mockResolvedValue({
      english: 'stress thermique',
      sourceLocale: 'fr',
      status: 'pending',
    })
    tryHandleStaffOpsCommand.mockResolvedValue({ handled: true, reply: 'Rejected.' })

    await sendText('reject TSK-A1B2C3 stress thermique', 109)

    expect(tryHandleStaffOpsCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'reject TSK-A1B2C3 stress thermique',
        noteLocale: { sourceLocale: 'fr', translationStatus: 'pending' },
      }),
    )
  })
})
