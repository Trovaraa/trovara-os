import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { actionDrafts } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { sendWhatsAppText } from './whatsapp-meta.js'
import { recordChatMessage } from './butler-core.js'
import { resolveStaffReplyLocale, type ReplyLocale } from './reply-locale.js'
import {
  cancelActionDraft,
  confirmActionDraft,
  getLatestPendingDraftAny,
} from './task-drafts.js'
import { canonicalDraftPayload, unhandledDraftMessage } from './draft-canonical.js'
import {
  executeConfirmedCropCycle,
  executeConfirmedLivestockBatch,
} from './action-draft-farm.js'
import { applyConfirmedOpsDraft } from './action-draft-ops.js'
import { applyConfirmedInventoryDraft } from './action-draft-inventory.js'
import { applyConfirmedZoneDraft } from './action-draft-zones.js'
import { applyConfirmedLivestockLogDraft } from './action-draft-livestock-log.js'
import { applyConfirmedLotDraft } from './lot-enrich.js'

const ENTITY = 'whatsapp_message'

type DraftAction = 'confirm' | 'cancel'

type KeywordSpec = {
  /** Exactly what the prompt shows the worker. */
  display: string
  /** Same word, spellings a worker plausibly types instead. */
  variants: readonly string[]
}

/**
 * Confirm/cancel keywords per language. `display` is the single source for both
 * the prompt and the matcher, so the word we advertise is always a word we
 * accept.
 *
 * Pidgin reuses the English words on purpose: the Pidgin help text already says
 * "WhatsApp: CONFIRM / CANCEL", and the locale tables carry no distinct Pidgin
 * imperative ("don confirm", "don cancel" are the forms in use). Accepting an
 * invented keyword no prompt ever sends would only widen the fall-through.
 */
const DRAFT_KEYWORDS: Record<ReplyLocale, Record<DraftAction, KeywordSpec>> = {
  en: {
    confirm: { display: 'CONFIRM', variants: [] },
    cancel: { display: 'CANCEL', variants: [] },
  },
  fr: {
    // "confirme" / "annule" are the tu-imperative of the same verbs.
    confirm: { display: 'CONFIRMER', variants: ['confirme'] },
    cancel: { display: 'ANNULER', variants: ['annule'] },
  },
  yo: {
    // "jeri" is JẸ́RÌÍ without the doubled final vowel.
    confirm: { display: 'JẸ́RÌÍ', variants: ['jeri'] },
    cancel: { display: 'FAGILÉ', variants: [] },
  },
  pcm: {
    confirm: { display: 'CONFIRM', variants: [] },
    cancel: { display: 'CANCEL', variants: [] },
  },
}

/**
 * Case and tone marks are dropped so JẸ́RÌÍ still matches on a phone keyboard
 * that cannot type them, and FAGILÉ matches FAGILE.
 */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .trim()
    .toLowerCase()
}

function acceptedFor(action: DraftAction): ReadonlySet<string> {
  const words = new Set<string>()
  for (const spec of Object.values(DRAFT_KEYWORDS)) {
    words.add(fold(spec[action].display))
    for (const variant of spec[action].variants) words.add(fold(variant))
  }
  return words
}

const ACCEPTED: Record<DraftAction, ReadonlySet<string>> = {
  confirm: acceptedFor('confirm'),
  cancel: acceptedFor('cancel'),
}

/**
 * The whole message must be the keyword and nothing else, which is what keeps
 * the fall-through contract intact: "Confirmer la tâche demain ?" still reaches
 * the butler, "confirm TRV-ORD-2026-014" still reaches the order commands, and
 * "/confirm" still opens the order pick list.
 *
 * Deliberately not accepted, because each is plausible conversation and would be
 * swallowed instead of answered: ok, okay, yes, sure, oui, d'accord, bẹ́ẹ̀ni,
 * "na so", oya, abeg — and, more dangerously, the bare negatives no, non, rara,
 * stop, which would silently discard the worker's draft.
 */
export function matchDraftKeyword(text: string): DraftAction | null {
  const folded = fold(text)
  if (!folded) return null
  if (ACCEPTED.confirm.has(folded)) return 'confirm'
  if (ACCEPTED.cancel.has(folded)) return 'cancel'
  return null
}

type LocaleTable = Record<ReplyLocale, string>

function pick(locale: ReplyLocale, table: LocaleTable): string {
  return table[locale] ?? table.en
}

/**
 * The prompt that tells a worker which keyword to send, built from the same
 * table `matchDraftKeyword` reads so the two cannot drift apart.
 */
export function draftConfirmHint(preferredLocale?: string | null): string {
  const locale = resolveStaffReplyLocale(preferredLocale)
  const confirm = DRAFT_KEYWORDS[locale].confirm.display
  const cancel = DRAFT_KEYWORDS[locale].cancel.display
  return pick(locale, {
    en: `Reply ${confirm} to save, or ${cancel}.`,
    fr: `Répondez ${confirm} pour enregistrer, ou ${cancel}.`,
    yo: `Dáhùn ${confirm} láti fipamọ́, tàbí ${cancel}.`,
    pcm: `Reply ${confirm} to save, or ${cancel}.`,
  })
}

const FIXED_REPLIES: Record<'cancelled' | 'resolved' | 'expired', LocaleTable> = {
  cancelled: {
    en: 'Cancelled. Nothing was written.',
    fr: 'Annulé. Rien n’a été enregistré.',
    yo: 'A ti fagilé. A kò kọ ohunkóhun sílẹ̀.',
    pcm: 'Cancelled. Nothing enter.',
  },
  resolved: {
    en: 'Draft already resolved.',
    fr: 'Ce brouillon est déjà traité.',
    yo: 'Àkọsílẹ̀ yìí ti parí tẹ́lẹ̀.',
    pcm: 'Dis draft don settle already.',
  },
  expired: {
    en: 'Draft expired. Please create it again.',
    fr: 'Brouillon expiré. Veuillez le recréer.',
    yo: 'Àkọsílẹ̀ ti tán àkókò. Jọ̀wọ́ ṣe é lẹ́ẹ̀kan sí i.',
    pcm: 'Di draft don expire. Abeg create am again.',
  },
}

/**
 * Send a reply and log the assistant side of the conversation in canonical
 * English.
 *
 * Every reply on this path is either a locale-table entry or English text the
 * apply step returned, so the English is already in hand and recording it costs
 * no translation call. The wording the worker actually received is kept in
 * `originalText` — the same metadata shape the inbound side uses — so the
 * delivered message stays recoverable for an auditor.
 */
async function reply(
  user: SessionUser,
  phone: string,
  locale: ReplyLocale,
  english: string,
  delivered: string = english,
): Promise<void> {
  await sendWhatsAppText(phone, delivered).catch(() => undefined)
  await recordChatMessage({
    farmId: user.farmId,
    userId: user.id,
    entityType: ENTITY,
    messageId: `whatsapp-confirm-out-${Date.now()}`,
    text: english,
    role: 'assistant',
    direction: 'outbound',
    extra: {
      sourceLocale: locale,
      translationStatus: 'done',
      ...(delivered === english ? {} : { originalText: delivered }),
    },
  }).catch(() => undefined)
}

/**
 * WhatsApp draft confirm/cancel (no inline buttons — Telegram uses those, so it
 * never reads a keyword). A bare keyword in any of the four languages, and only
 * when a pending draft exists — otherwise returns false so callers fall through.
 */
export async function tryHandleWhatsAppDraftConfirm(
  user: SessionUser,
  phone: string,
  text: string,
  preferredLocale?: string | null,
): Promise<boolean> {
  const action = matchDraftKeyword(text)
  if (!action) return false

  const draft = await getLatestPendingDraftAny(user.id)
  if (!draft) return false

  const locale = resolveStaffReplyLocale(preferredLocale)

  if (action === 'cancel') {
    const ok = await cancelActionDraft(draft.id, user.id)
    const kind = ok ? 'cancelled' : 'resolved'
    await reply(user, phone, locale, FIXED_REPLIES[kind].en, pick(locale, FIXED_REPLIES[kind]))
    return true
  }

  const confirmed = await confirmActionDraft(draft.id, user.id)
  if (!confirmed) {
    await reply(
      user,
      phone,
      locale,
      FIXED_REPLIES.expired.en,
      pick(locale, FIXED_REPLIES.expired),
    )
    return true
  }

  const { payload, locale: contentLocale } = await canonicalDraftPayload(confirmed)

  let result = 'Confirmed.'
  try {
    const opsResult = await applyConfirmedOpsDraft(
      user,
      confirmed.actionType,
      payload,
      'whatsapp_confirm',
      contentLocale,
    )
    if (opsResult != null) {
      result = opsResult
    } else {
      const invResult = await applyConfirmedInventoryDraft(
        user,
        confirmed.actionType,
        payload,
        'whatsapp_confirm',
        contentLocale,
      )
      if (invResult != null) {
        result = invResult
      } else {
        const zoneResult = await applyConfirmedZoneDraft(
          user,
          confirmed.actionType,
          payload,
          'whatsapp_confirm',
        )
        if (zoneResult != null) {
          result = zoneResult
        } else {
          const logResult = await applyConfirmedLivestockLogDraft(
            user,
            confirmed.actionType,
            payload,
            'whatsapp_confirm',
            contentLocale,
          )
          if (logResult != null) {
            result = logResult
          } else {
            const lotResult = await applyConfirmedLotDraft(
              user,
              confirmed.actionType,
              payload,
              contentLocale,
            )
            if (lotResult != null) {
              result = lotResult
            } else if (confirmed.actionType === 'create_crop_cycle') {
              result = await executeConfirmedCropCycle(user, payload)
            } else if (confirmed.actionType === 'create_livestock_batch') {
              result = await executeConfirmedLivestockBatch(user, payload)
            } else {
              result = unhandledDraftMessage(confirmed.actionType)
            }
          }
        }
      }
    }
  } catch (err) {
    result = err instanceof Error ? err.message : 'Could not apply draft'
  }
  // The apply step returns English, so this is stored exactly as it was sent.
  await reply(user, phone, locale, result)
  return true
}
