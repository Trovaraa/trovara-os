import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { actionDrafts } from '../db/schema.js'
import { toCanonicalEnglish } from './content-locale.js'
import {
  draftContentLocale,
  type ActionDraftPayload,
  type ContentLocaleMeta,
  type StoredActionDraft,
} from './task-drafts.js'

/**
 * Free-text payload fields per draft type. These are the only fields carrying
 * worker prose; everything else in a payload is an id, a code, a quantity, or a
 * name matched by exact string (plot, zone, batch, item, lot), which must
 * survive translation untouched or intent parsing and lookups break.
 *
 * `cropType` and `species` are deliberately absent: they are lookup keys,
 * normalized by the deterministic `crop-normalize` / `species-normalize` lexicons
 * at draft creation. Listing them here would let the confirm path and the retry
 * job hand them to the translator later, which is the silent-mismatch bug the
 * lexicons exist to prevent. `speciesTyped` is display-only — it is the worker's
 * own words, so translating it would defeat its whole purpose.
 *
 * This lives in a channel-neutral module because Telegram and WhatsApp both
 * write to `action_drafts` and the retry job sweeps the table regardless of
 * which one created the row.
 */
export const DRAFT_FREE_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  create_task: ['title', 'description'],
  create_zone: ['description'],
  livestock_log: ['notes'],
  stock_move: ['reason'],
  create_field_report: ['description'],
  create_support_ticket: ['description'],
  verify_lot: ['note'],
  enrich_lot: ['publicNotes'],
}

/**
 * Reply for a confirmed draft no executor claimed. Shared so both channels say
 * the same thing, and worded honestly: the draft is spent but nothing was
 * written, so "confirmed" would be a lie and pointing the worker at the other
 * chat channel would not help — only the web app can finish it.
 *
 * Unreachable while every draft type has an executor; it exists so adding a
 * seventh type fails loudly rather than silently dropping a worker's report.
 */
export function unhandledDraftMessage(actionType: string): string {
  return `Nothing was saved: "${actionType}" cannot be completed from chat. Please finish it in the web app.`
}

export type CanonicalDraftPayload = {
  payload: ActionDraftPayload
  locale: ContentLocaleMeta
}

/**
 * Normalize a draft payload to English before it is stored, and report the
 * locale pair the draft row has to carry.
 *
 * The default runs the other way from `DRAFT_FREE_TEXT_FIELDS`: `verbatim`
 * names the keys that are ids, codes, lexicon keys and entity names, and every
 * other string is worker prose. A producer that gains a field therefore
 * canonicalizes it by inheritance, instead of storing the author's own words
 * labelled 'done' — which the retry job filters out, so nothing looks at that
 * text again — until somebody remembers to wire the field up.
 *
 * The status is the weakest of the fields: one string the translator could not
 * convert makes the whole draft 'pending', because one pair of columns
 * describes the whole row.
 */
export async function canonicalizeDraftPayload(params: {
  farmId: string
  payload: ActionDraftPayload
  verbatim: readonly string[]
  authorLocale?: string | null
}): Promise<CanonicalDraftPayload> {
  const verbatim = new Set(params.verbatim)
  const payload = { ...params.payload }
  const results: { sourceLocale: string | null; status: 'done' | 'pending' }[] = []

  for (const [field, value] of Object.entries(payload)) {
    if (verbatim.has(field) || typeof value !== 'string' || !value.trim()) continue
    const result = await toCanonicalEnglish({
      text: value,
      farmId: params.farmId,
      sourceLocale: params.authorLocale,
    })
    payload[field] = result.english
    results.push({ sourceLocale: result.sourceLocale, status: result.status })
  }

  if (!results.length) return { payload, locale: {} }
  const foreign = results.find((result) => result.sourceLocale !== 'en')
  return {
    payload,
    locale: {
      sourceLocale: (foreign ?? results[0]).sourceLocale,
      translationStatus: results.some((result) => result.status === 'pending')
        ? 'pending'
        : 'done',
    },
  }
}

/**
 * Payload free text is normalized to English when the draft is created, so
 * confirming translates nothing — except when the LLM was unavailable back then
 * and the payload still holds the author's own words
 * (`translationStatus: 'pending'`). Confirmation is the last moment before the
 * text lands in a real row, so a pending draft gets one retry here; if that
 * retry also fails the original text is applied and the draft stays 'pending'
 * for the retry job.
 *
 * The locale returned is the post-retry status so a successful retry writes
 * `done` onto the content row rather than the draft's pre-retry `pending`.
 */
export async function canonicalDraftPayload(
  draft: StoredActionDraft,
): Promise<CanonicalDraftPayload> {
  const locale = draftContentLocale(draft)
  const fields = DRAFT_FREE_TEXT_FIELDS[draft.actionType]
  if (!fields?.length) return { payload: draft.payload, locale }

  try {
    const [row] = await db
      .select({
        sourceLocale: actionDrafts.sourceLocale,
        translationStatus: actionDrafts.translationStatus,
      })
      .from(actionDrafts)
      .where(eq(actionDrafts.id, draft.id))
      .limit(1)
    if (row?.translationStatus !== 'pending') return { payload: draft.payload, locale }

    const payload = { ...draft.payload }
    let translated = false
    let pending = false
    for (const field of fields) {
      const value = payload[field]
      if (typeof value !== 'string' || !value.trim()) continue
      const result = await toCanonicalEnglish({
        text: value,
        farmId: draft.farmId,
        sourceLocale: row.sourceLocale,
      })
      if (result.status === 'pending') {
        pending = true
        continue
      }
      if (result.english !== value) {
        payload[field] = result.english
        translated = true
      }
    }

    if (!translated && pending) return { payload: draft.payload, locale }

    const nextStatus = pending ? 'pending' : 'done'
    // Bookkeeping is best-effort: the English payload is applied either way.
    try {
      await db
        .update(actionDrafts)
        .set({ payload, translationStatus: nextStatus })
        .where(eq(actionDrafts.id, draft.id))
    } catch {
      /* ignore */
    }
    return {
      payload,
      locale: { sourceLocale: row.sourceLocale, translationStatus: nextStatus },
    }
  } catch {
    // A translation failure must never block the write the worker just confirmed.
    return { payload: draft.payload, locale }
  }
}
