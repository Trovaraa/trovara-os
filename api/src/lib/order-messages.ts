import { normalizeLocaleHint, type ReplyLocale } from './reply-locale.js'

export type StaffLocale = ReplyLocale

export function staffLocale(raw?: string | null): StaffLocale {
  return normalizeLocaleHint(raw) ?? 'en'
}

type Msg = Record<StaffLocale, string>

function pick(locale: StaffLocale, table: Msg): string {
  return table[locale] ?? table.en
}

export function newOrderStaffMessage(params: {
  locale: StaffLocale
  reference: string
  channel: string
  itemLines: string
  /** Preformatted total line, e.g. "Total: ₦13,000" or "Total: price on request" */
  totalLine?: string
  lotCode?: string
  customerName: string
  phone: string
  address: string
}): string {
  const lot = params.lotCode ?? 'pending'
  const total = params.totalLine?.trim() ? `\n${params.totalLine.trim()}` : ''
  return pick(params.locale, {
    en: `🛒 New order ${params.reference} (${params.channel})\n${params.itemLines}${total}\n\nLot: ${lot}\nCustomer: ${params.customerName}\nPhone: ${params.phone}\nDeliver to: ${params.address}\n\nReply: confirm ${params.reference} | cancel ${params.reference}\nOr use the buttons below.`,
    fr: `🛒 Nouvelle commande ${params.reference} (${params.channel})\n${params.itemLines}${total}\n\nLot : ${lot}\nClient : ${params.customerName}\nTél : ${params.phone}\nLivraison : ${params.address}\n\nRépondez : confirm ${params.reference} | cancel ${params.reference}`,
    yo: `🛒 Àṣẹ tuntun ${params.reference} (${params.channel})\n${params.itemLines}${total}\n\nLot: ${lot}\nOníbàárà: ${params.customerName}\nFóònù: ${params.phone}\nIbùdó: ${params.address}\n\nDáhùn: confirm ${params.reference} | cancel ${params.reference}`,
    pcm: `🛒 New order ${params.reference} (${params.channel})\n${params.itemLines}${total}\n\nLot: ${lot}\nCustomer: ${params.customerName}\nPhone: ${params.phone}\nDeliver to: ${params.address}\n\nReply: confirm ${params.reference} | cancel ${params.reference}`,
  })
}

export function customerStatusMessage(params: {
  locale: StaffLocale
  reference: string
  status: 'confirmed' | 'dispatched' | 'delivered' | 'cancelled'
}): string {
  const ref = params.reference
  switch (params.status) {
    case 'confirmed':
      return pick(params.locale, {
        en: `✅ Your order ${ref} is confirmed. We'll notify you when it's out for delivery.`,
        fr: `✅ Votre commande ${ref} est confirmée. Nous vous préviendrons quand elle sera en livraison.`,
        yo: `✅ Àṣẹ rẹ ${ref} ti jẹ́rìí. A ó ránṣẹ́ sí ọ nígbà tí ó bá ń lọ.`,
        pcm: `✅ Your order ${ref} don confirm. We go tell you when e dey go delivery.`,
      })
    case 'dispatched':
      return pick(params.locale, {
        en: `🚚 Your order ${ref} is out for delivery.`,
        fr: `🚚 Votre commande ${ref} est en cours de livraison.`,
        yo: `🚚 Àṣẹ rẹ ${ref} ti bẹ̀rẹ̀ ìfihàn.`,
        pcm: `🚚 Your order ${ref} dey on the way.`,
      })
    case 'delivered':
      return pick(params.locale, {
        en: `🙏 Thank you! Order ${ref} was delivered.\n\nHow was it? Reply with 1–5 stars or a short note — we read every reply.`,
        fr: `🙏 Merci ! La commande ${ref} a été livrée.\n\nComment c’était ? Répondez avec 1–5 étoiles ou un court message.`,
        yo: `🙏 O ṣeun! Àṣẹ ${ref} ti dé.\n\nBáwo ni? Dahùn pẹ̀lú 1–5 tàbí ọ̀rọ̀ kukuru.`,
        pcm: `🙏 Thank you! Order ${ref} don deliver.\n\nHow e be? Reply with 1–5 stars or small note.`,
      })
    case 'cancelled':
      return pick(params.locale, {
        en: `Your order ${ref} was cancelled. Message us if you have questions.`,
        fr: `Votre commande ${ref} a été annulée. Écrivez-nous pour toute question.`,
        yo: `Àṣẹ rẹ ${ref} ti fagilé. Kọ̀wé sí wa tí o bá ní ìbéèrè.`,
        pcm: `Your order ${ref} don cancel. Message us if you get question.`,
      })
  }
}

export function feedbackThanksMessage(locale: StaffLocale): string {
  return pick(locale, {
    en: 'Thanks for the feedback — it helps us improve.',
    fr: 'Merci pour votre avis — cela nous aide à nous améliorer.',
    yo: 'O ṣeun fún èsì rẹ — ó ń ràn wá lọ́wọ́.',
    pcm: 'Thanks for di feedback — e dey help us improve.',
  })
}

export function feedbackStaffSummary(params: {
  locale: StaffLocale
  reference: string
  customerName: string
  feedback: string
}): string {
  return pick(params.locale, {
    en: `⭐ Feedback on ${params.reference} from ${params.customerName}:\n"${params.feedback}"`,
    fr: `⭐ Avis sur ${params.reference} de ${params.customerName} :\n« ${params.feedback} »`,
    yo: `⭐ Èsì lórí ${params.reference} láti ọ̀dọ̀ ${params.customerName}:\n"${params.feedback}"`,
    pcm: `⭐ Feedback on ${params.reference} from ${params.customerName}:\n"${params.feedback}"`,
  })
}

export function languagePromptMessage(locale: StaffLocale = 'en'): string {
  return pick(locale, {
    en: 'Choose your language for this bot:',
    fr: 'Choisissez votre langue pour ce bot :',
    yo: 'Yan èdè rẹ fún bot yìí:',
    pcm: 'Choose your language for this bot:',
  })
}

export function languageSavedMessage(locale: StaffLocale): string {
  return pick(locale, {
    en: 'Language saved. I will use English for all butler chat, order alerts, and replies from now on.',
    fr: 'Langue enregistrée. Je répondrai en français pour tout le chat butler, les alertes commandes et les réponses.',
    yo: 'Èdè ti fipamọ́. Máa lo Yorùbá fún gbogbo ìjíròrò butler, ìfitonilétí àṣẹ, àti ìdáhùn.',
    pcm: 'Language save. I go use Pidgin for all butler chat, order alerts, and replies from now.',
  })
}

export function orderActionResultMessage(params: {
  locale: StaffLocale
  reference: string
  status: string
  ok: boolean
  error?: string
}): string {
  if (!params.ok) {
    return pick(params.locale, {
      en: `Could not update ${params.reference}: ${params.error ?? 'failed'}`,
      fr: `Impossible de mettre à jour ${params.reference} : ${params.error ?? 'échec'}`,
      yo: `Kò lè ṣe àtúnṣe ${params.reference}: ${params.error ?? 'kùnà'}`,
      pcm: `I no fit update ${params.reference}: ${params.error ?? 'fail'}`,
    })
  }
  return pick(params.locale, {
    en: `Order ${params.reference} → ${params.status}`,
    fr: `Commande ${params.reference} → ${params.status}`,
    yo: `Àṣẹ ${params.reference} → ${params.status}`,
    pcm: `Order ${params.reference} → ${params.status}`,
  })
}

export function orderCommandHelp(locale: StaffLocale): string {
  return pick(locale, {
    en: 'Orders (tap / in chat for shortcuts):\n/confirm · /dispatch · /delivered · /cancel TRV-ORD-…\nOr: confirm TRV-ORD-… | dispatch TRV-ORD-… | delivered TRV-ORD-…\nWithout an id, /dispatch and /delivered show a pick list.\nPhoto: caption delivered TRV-ORD-…\nLanguage: /language',
    fr: 'Commandes (tapez / pour les raccourcis) :\n/confirm · /dispatch · /delivered · /cancel TRV-ORD-…\nSans id, /dispatch et /delivered affichent une liste.\nPhoto : légende delivered TRV-ORD-…\nLangue : /language',
    yo: 'Àṣẹ (tẹ / fún ọ̀nà kíákíá):\n/confirm · /dispatch · /delivered · /cancel TRV-ORD-…\nLáìsí id, /dispatch àti /delivered máa fi àkójọ hàn.\nÀwòrán: caption delivered TRV-ORD-…\nÈdè: /language',
    pcm: 'Orders (tap / for shortcuts):\n/confirm · /dispatch · /delivered · /cancel TRV-ORD-…\nWithout id, /dispatch and /delivered go show pick list.\nPhoto: caption delivered TRV-ORD-…\nLanguage: /language',
  })
}
