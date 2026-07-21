/**
 * Lightweight reply-locale detection for offline (no-LLM) fallbacks.
 * Staff preferred_locale (from Telegram/WhatsApp onboarding) overrides heuristics.
 */

export type ReplyLocale = 'en' | 'yo' | 'pcm' | 'fr'

const FR_CHARS = /[àâäéèêëïîôùûüçœæ]/i
const FR_WORDS =
  /\b(bonjour|bonsoir|merci|comment|combien|où|avez|avez[- ]vous|s['']il|svp|livraison|livrer|prix|produit|produits|payer|paiement|disponible|vendez|oeufs?|œufs?|banane|plantain|ferme|adresse|localis[ée]e?)\b/i

const YO_CHARS = /[ẹọṣńẸỌṢ]/
const YO_WORDS =
  /\b(bawo|ẹ\s*n\s*lẹ|pele|jowo|elo|nibo|mo\s*fẹ|e\s*se|sanwo|owó|iye)\b/i

const PCM_WORDS =
  /\b(wetin|abeg|una|how\s+far|no\s+be|e\s+dey|i\s+wan|make\s+una|wetin\s+be|how\s+much\s+e|una\s+dey|dey\s+sell|dey\s+deliver)\b/i

/** Normalize an optional UI/API locale hint (e.g. vue-i18n 'fr'). */
export function normalizeLocaleHint(hint?: string | null): ReplyLocale | null {
  const h = (hint ?? '').trim().toLowerCase()
  if (h === 'fr' || h === 'yo' || h === 'pcm' || h === 'en') return h
  if (h.startsWith('fr')) return 'fr'
  if (h.startsWith('yo')) return 'yo'
  if (h === 'pidgin' || h.startsWith('pcm')) return 'pcm'
  return null
}

export function localeDisplayName(locale: ReplyLocale): string {
  switch (locale) {
    case 'fr':
      return 'French'
    case 'yo':
      return 'Yoruba'
    case 'pcm':
      return 'Nigerian Pidgin'
    default:
      return 'English'
  }
}

/**
 * Staff butler language: preferred_locale always wins when set.
 * Used for all chat replies, help, briefings, and outbound staff alerts.
 */
export function resolveStaffReplyLocale(preferredLocale?: string | null): ReplyLocale {
  return normalizeLocaleHint(preferredLocale) ?? 'en'
}

/**
 * Detect reply language from user text. Prefer strong text signals; if the
 * message is empty/very short, fall back to an optional UI locale hint.
 * For staff channels, prefer resolveStaffReplyLocale(preferred) instead.
 */
export function detectReplyLocale(text: string, hint?: string | null): ReplyLocale {
  const trimmed = (text ?? '').trim()
  const hintLocale = normalizeLocaleHint(hint)

  if (trimmed.length < 2) return hintLocale ?? 'en'

  let fr = 0
  let yo = 0
  let pcm = 0

  if (FR_CHARS.test(trimmed)) fr += 2
  if (FR_WORDS.test(trimmed)) fr += 3
  if (YO_CHARS.test(trimmed)) yo += 3
  if (YO_WORDS.test(trimmed)) yo += 2
  if (PCM_WORDS.test(trimmed)) pcm += 3
  // Common Pidgin "dey" alone is weaker (can appear in English typos)
  if (/\bdey\b/i.test(trimmed)) pcm += 1

  const best = Math.max(fr, yo, pcm)
  if (best === 0) return hintLocale ?? 'en'
  if (fr === best) return 'fr'
  if (yo === best) return 'yo'
  if (pcm === best) return 'pcm'
  return hintLocale ?? 'en'
}

type MsgTable = Record<ReplyLocale, string>

function pick(locale: ReplyLocale, table: MsgTable): string {
  return table[locale] ?? table.en
}

/** Staff butler: LLM not configured. */
export function butlerLlmOffMessage(locale: ReplyLocale, firstName: string, excerpt: string): string {
  return pick(locale, {
    en: `Hi ${firstName}, I received: "${excerpt}". The AI assistant is not switched on yet - a supervisor will follow up.`,
    fr: `Bonjour ${firstName}, j’ai reçu : « ${excerpt} ». L’assistant IA n’est pas encore activé - un superviseur fera le suivi.`,
    yo: `Pẹ̀lẹ́ ${firstName}, mo gba: "${excerpt}". Olùrànlọ́wọ́ AI kò tíì ṣiṣẹ́ - alábojútó kan yóò tẹ̀lé e.`,
    pcm: `Hi ${firstName}, I receive: "${excerpt}". Di AI assistant never on yet - supervisor go follow up.`,
  })
}

export function butlerBriefFailedMessage(locale: ReplyLocale): string {
  return pick(locale, {
    en: 'Could not build the briefing right now. Please try again shortly.',
    fr: 'Impossible de préparer le briefing pour le moment. Réessayez bientôt.',
    yo: 'Kò lè ṣe ìsọfúnni náà ní báyìí. Jọ̀wọ́ gbìyànjú lẹ́ẹ̀kan sí i.',
    pcm: 'I no fit build di briefing now. Abeg try again small time.',
  })
}

export function butlerAnswerFailedMessage(locale: ReplyLocale): string {
  return pick(locale, {
    en: 'I had trouble answering that just now. Please try again in a moment.',
    fr: 'J’ai eu du mal à répondre à l’instant. Réessayez dans un moment.',
    yo: 'Ó ṣòro fún mi láti dáhùn báyìí. Jọ̀wọ́ gbìyànjú ní ìṣẹ́jú díẹ̀.',
    pcm: 'I get wahala to answer am now. Abeg try again small time.',
  })
}

export function butlerPhotoLlmOffMessage(locale: ReplyLocale): string {
  return pick(locale, {
    en: 'Photo received. The AI diagnosis service is not switched on yet - a supervisor will review it.',
    fr: 'Photo reçue. Le service de diagnostic IA n’est pas encore activé - un superviseur l’examinera.',
    yo: 'A gba fọ́tò. Iṣẹ́ àyẹ̀wò AI kò tíì ṣiṣẹ́ - alábojútó kan yóò wo ó.',
    pcm: 'Photo don land. Di AI diagnosis never on yet - supervisor go review am.',
  })
}

export function butlerPhotoFailedMessage(locale: ReplyLocale): string {
  return pick(locale, {
    en: 'I could not open that photo. Please resend a clear, well-lit picture of the plant or animal.',
    fr: 'Je n’ai pas pu ouvrir cette photo. Renvoyez une image claire et bien éclairée de la plante ou de l’animal.',
    yo: 'Mi ò lè ṣí fọ́tò yẹn. Jọ̀wọ́ tún fi àwòrán tó mó, tó ní ìmọ́lẹ̀ ránṣẹ́.',
    pcm: 'I no fit open dat photo. Abeg send clear picture wey get light of di plant or animal.',
  })
}

export function butlerHelpText(locale: ReplyLocale): string {
  return pick(locale, {
    en: [
      'Trovara Butler - how I can help:',
      '• Ask anything: "How many birds are alive?", "What needs restocking?", "Revenue today?"',
      '• Report a problem: "3 broilers are weak with green droppings"',
      '• Send a photo of a sick plant or animal and I will diagnose it',
      '• Type "brief" for today\'s summary',
    ].join('\n'),
    fr: [
      'Trovara Butler - comment je peux aider :',
      '• Posez une question : « Combien d’oiseaux sont vivants ? », « Que faut-il réapprovisionner ? », « Revenus aujourd’hui ? »',
      '• Signalez un problème : « 3 poulets sont faibles avec des déjections vertes »',
      '• Envoyez une photo d’une plante ou d’un animal malade pour un diagnostic',
      '• Tapez « brief » pour le résumé du jour',
    ].join('\n'),
    yo: [
      'Trovara Butler - bí mo ṣe lè ràn ọ́ lọ́wọ́:',
      '• Béèrè ohunkóhun: "Ẹyẹ mélòó ló wà láàyè?", "Kí ló nílò ìkúnjú?", "Owó wọlé lónìí?"',
      '• Ròyìn ìṣòro: "Àwọn broiler mẹ́ta kò le, wọ́n ń ya ìmí aláwọ̀ ewé"',
      '• Fi fọ́tò ọ̀gbìn tàbí ẹranko aláìsàn ránṣẹ́, màá ṣàyẹ̀wò rẹ̀',
      '• Tẹ "brief" fún àkótán òní',
    ].join('\n'),
    pcm: [
      'Trovara Butler - how I fit help:',
      '• Ask anything: "How many birds dey alive?", "Wetin need restock?", "Revenue today?"',
      '• Report problem: "3 broilers weak with green droppings"',
      '• Send photo of sick plant or animal make I diagnose am',
      '• Type "brief" for today summary',
    ].join('\n'),
  })
}

export function voiceNotUnderstoodMessage(locale: ReplyLocale): string {
  return pick(locale, {
    en: "I couldn't understand that voice note. Please try again, speak clearly, or type your message.",
    fr: 'Je n’ai pas compris cette note vocale. Réessayez, parlez clairement, ou écrivez votre message.',
    yo: 'Mi ò ye ohun tí o sọ nínú àkọsílẹ̀ ohùn. Jọ̀wọ́ gbìyànjú, sọ̀rọ̀ kedere, tàbí kọ ọ̀rọ̀ rẹ.',
    pcm: 'I no understand dat voice note. Abeg try again, talk clear, or type your message.',
  })
}

/** Web Copilot: LLM not configured. */
export function webCopilotLlmOffMessage(locale: ReplyLocale): string {
  return pick(locale, {
    en: 'The Copilot needs an AI key to answer questions. Add OPENAI_API_KEY (or LLM_API_KEY) to your .env and restart the API. Until then, use the dashboard and Reports pages to find this information.',
    fr: 'Le Copilote a besoin d’une clé IA pour répondre. Ajoutez OPENAI_API_KEY (ou LLM_API_KEY) dans votre .env et redémarrez l’API. En attendant, utilisez le tableau de bord et Rapports.',
    yo: 'Copilot nílò bọtínnì AI láti dáhùn. Fi OPENAI_API_KEY (tàbí LLM_API_KEY) kún .env rẹ, kí o sì tún API bẹ̀rẹ̀. Títí tó fi ṣẹ́, lo Dashboard àti Reports.',
    pcm: 'Di Copilot need AI key to answer. Add OPENAI_API_KEY (or LLM_API_KEY) for your .env and restart di API. Until den, use dashboard and Reports page.',
  })
}

export function webCopilotUnavailableMessage(locale: ReplyLocale): string {
  return pick(locale, {
    en: 'The Copilot could not reach the AI service. Please try again in a moment.',
    fr: 'Le Copilote n’a pas pu joindre le service IA. Réessayez dans un moment.',
    yo: 'Copilot kò lè kan sí iṣẹ́ AI. Jọ̀wọ́ gbìyànjú ní ìṣẹ́jú díẹ̀.',
    pcm: 'Di Copilot no fit reach di AI service. Abeg try again small time.',
  })
}

/** Customer-bot offline FAQ reply strings. */
export function customerCatalogReply(
  locale: ReplyLocale,
  lines: string,
  opts: { kind: 'matched' | 'priceList' | 'whatWeSell' | 'thanks'; farmName?: string },
): string {
  const orderHint = pick(locale, {
    en: 'Reply "1" to place an order.',
    fr: 'Répondez « 1 » pour passer commande.',
    yo: 'Dáhùn "1" láti ṣe òrder.',
    pcm: 'Reply "1" to place order.',
  })

  switch (opts.kind) {
    case 'matched':
      return pick(locale, {
        en: `Yes! Here's what we have:\n\n${lines}\n\n${orderHint}`,
        fr: `Oui ! Voici ce que nous avons :\n\n${lines}\n\n${orderHint}`,
        yo: `Bẹ́ẹ̀ni! Èyí ni ohun tí a ní:\n\n${lines}\n\n${orderHint}`,
        pcm: `Yes! Na wetin we get be dis:\n\n${lines}\n\n${orderHint}`,
      })
    case 'priceList':
      return pick(locale, {
        en: `Here's our price list:\n\n${lines}\n\nReply "1" to order.`,
        fr: `Voici notre liste de prix :\n\n${lines}\n\nRépondez « 1 » pour commander.`,
        yo: `Èyí ni àtòjọ iye owó wa:\n\n${lines}\n\nDáhùn "1" láti ṣe òrder.`,
        pcm: `Na our price list be dis:\n\n${lines}\n\nReply "1" to order.`,
      })
    case 'whatWeSell':
      return pick(locale, {
        en: `Here's what we sell:\n\n${lines}\n\n${orderHint}`,
        fr: `Voici ce que nous vendons :\n\n${lines}\n\n${orderHint}`,
        yo: `Èyí ni ohun tí a ń tà:\n\n${lines}\n\n${orderHint}`,
        pcm: `Na wetin we dey sell be dis:\n\n${lines}\n\n${orderHint}`,
      })
    case 'thanks': {
      const name = opts.farmName ?? 'Trovara'
      return pick(locale, {
        en: `Thanks for reaching out to ${name}! Here's what we sell:\n\n${lines}\n\nReply "1" to place an order, or ask me anything about our produce.`,
        fr: `Merci d’avoir contacté ${name} ! Voici ce que nous vendons :\n\n${lines}\n\nRépondez « 1 » pour commander, ou posez-moi une question sur nos produits.`,
        yo: `O ṣeun tí o kàn sí ${name}! Èyí ni ohun tí a ń tà:\n\n${lines}\n\nDáhùn "1" láti ṣe òrder, tàbí béèrè nípa ọjà wa.`,
        pcm: `Thanks say you reach ${name}! Na wetin we dey sell be dis:\n\n${lines}\n\nReply "1" to order, or ask me anything about our produce.`,
      })
    }
  }
}

export function customerLocationReply(
  locale: ReplyLocale,
  farmName: string,
  farmLocation: string,
): string {
  return pick(locale, {
    en: `${farmName} is based in ${farmLocation}. We deliver to you - reply "1" to order.`,
    fr: `${farmName} est basé à ${farmLocation}. Nous livrons chez vous - répondez « 1 » pour commander.`,
    yo: `${farmName} wà ní ${farmLocation}. A máa mú ọjà wá sọ́dọ̀ rẹ - dáhùn "1" láti ṣe òrder.`,
    pcm: `${farmName} dey for ${farmLocation}. We go deliver give you - reply "1" to order.`,
  })
}

export function customerDeliveryReply(locale: ReplyLocale): string {
  return pick(locale, {
    en: 'We deliver to your address. After you order, we call to confirm, then deliver. Pay online via the link we send when prices are set, or pay on delivery otherwise.',
    fr: 'Nous livrons à votre adresse. Après votre commande, nous appelons pour confirmer, puis nous livrons. Payez en ligne via le lien envoyé lorsque les prix sont fixés, ou à la livraison sinon.',
    yo: 'A máa mú ọjà wá sí àdírẹ́sì rẹ. Lẹ́yìn òrder, a máa pè ọ́ láti jẹ́rìí, lẹ́yìn náà a óò fi ránṣẹ́. San owó lórí ayélujára nípasẹ̀ ìjápọ̀ tí a ránṣẹ́ tí owó bá ti wà, tàbí nígbà tí a bá dé.',
    pcm: 'We go deliver to your address. After you order, we go call to confirm, then deliver. Pay online with the link we send when price dey set, or pay on delivery if no link.',
  })
}

export function customerPaymentReply(locale: ReplyLocale): string {
  return pick(locale, {
    en: 'After you order, we send a Paystack payment link when all items have prices. Otherwise pay on delivery. Cancel within 24 hours with: cancel TRV-ORD-…',
    fr: 'Après votre commande, nous envoyons un lien Paystack lorsque tous les articles ont un prix. Sinon, paiement à la livraison. Annulez sous 24 h avec : cancel TRV-ORD-…',
    yo: 'Lẹ́yìn òrder, a máa fi ìjápọ̀ ìsanwó Paystack ránṣẹ́ tí gbogbo ọjà bá ní owó. Bí kò ṣe bẹ́ẹ̀, san nígbà tí a bá dé. Fagilé láàárín wákàtí 24 pẹ̀lú: cancel TRV-ORD-…',
    pcm: 'After you order, we go send Paystack payment link when all items get price. If no price, pay on delivery. Cancel within 24 hours with: cancel TRV-ORD-…',
  })
}

/** Multilingual keyword matchers for the offline customer FAQ. */
export const CUSTOMER_FAQ_MATCHERS = {
  price:
    /(price|cost|how much|much be|magnitude|₦|naira|prix|combien|co[uû]te|elo|iye\s*ow[oó]|wetin.*cost|how\s+much\s+e)/i,
  location:
    /(where|location|located|address|find you|come to|visit|où|localisation|adresse|trouver|nibo|where\s+(una|you)\s+dey)/i,
  delivery:
    /(deliver|delivery|ship|bring|dispatch|livraison|livrer|expédi|ifijiṣẹ|dey\s+deliver)/i,
  payment:
    /(pay|payment|transfer|card|cash|payer|paiement|virement|carte|esp[eè]ces|sanwo|how\s+i\s+go\s+pay)/i,
  catalog:
    /(what|which|available|sell|have|stock|catalog|catalogue|produce|product|quoi|vendez|produits?|disponible|kini|wetin\s+you\s+dey\s+sell|wetin\s+una\s+dey\s+sell)/i,
}
