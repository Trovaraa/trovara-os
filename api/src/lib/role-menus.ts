import type { UserRole } from '../db/schema.js'
import type { StaffLocale } from './order-messages.js'

export type TelegramBotCommand = { command: string; description: string }

function msg(locale: StaffLocale, table: Record<StaffLocale, string>): string {
  return table[locale] ?? table.en
}

/** Slash-menu entries shown when the user types / in Telegram (per chat). */
export function telegramCommandsForRole(role: UserRole): TelegramBotCommand[] {
  const common: TelegramBotCommand[] = [
    { command: 'help', description: 'Commands for your role' },
    { command: 'language', description: 'Change reply language' },
    { command: 'brief', description: "Today's farm summary" },
  ]

  if (role === 'field_worker') {
    return [
      ...common,
      { command: 'clockin', description: 'Clock in' },
      { command: 'clockout', description: 'Clock out' },
      { command: 'tasks', description: 'List my open tasks' },
      { command: 'taskstart', description: 'Start a task' },
      { command: 'done', description: 'Submit task for approval' },
      { command: 'handover', description: 'My handover tasks' },
    ]
  }

  if (role === 'sales') {
    return [
      ...common,
      { command: 'clockin', description: 'Clock in' },
      { command: 'clockout', description: 'Clock out' },
      { command: 'orders', description: 'Order commands' },
      { command: 'confirm', description: 'Confirm a pending order' },
      { command: 'dispatch', description: 'Mark order dispatched' },
      { command: 'delivered', description: 'Mark order delivered' },
      { command: 'cancel', description: 'Cancel an order' },
      { command: 'lots', description: 'Lots needing pack details' },
      { command: 'printqr', description: 'Print box QR label' },
    ]
  }

  return [
    ...common,
    { command: 'clockin', description: 'Clock in' },
    { command: 'clockout', description: 'Clock out' },
    { command: 'approve', description: 'Approve a waiting task' },
    { command: 'reject', description: 'Reject a waiting task' },
    { command: 'orders', description: 'Order commands' },
    { command: 'confirm', description: 'Confirm a pending order' },
    { command: 'dispatch', description: 'Mark order dispatched' },
    { command: 'delivered', description: 'Mark order delivered' },
    { command: 'lots', description: 'Lots needing pack details' },
    { command: 'printqr', description: 'Print box QR label' },
    { command: 'handover', description: 'Handover checklist progress' },
    { command: 'ops', description: 'Supervisor / admin command help' },
  ]
}

/**
 * Full help text for the linked staff role — only commands they can use.
 * Used by Telegram, WhatsApp, and Butler "help/menu".
 */
export function roleCommandHelp(locale: StaffLocale, role: UserRole): string {
  if (role === 'field_worker') {
    return msg(locale, {
      en: [
        'Your commands (field worker):',
        '/clockin · /clockout',
        '/tasks — my open tasks',
        '/taskstart — start a task',
        '/done · /done TSK-… note — submit for approval',
        'Photo caption: done TSK-…',
        '/handover — my handover tasks',
        '',
        'Livestock log (then CONFIRM):',
        'Feed: Noiler A · Vaccinate: Noiler A · Mortality: Noiler A heads=3',
        '',
        'Also: ask a farm question, send a plant/animal photo, or type brief',
        '/language — change reply language',
      ].join('\n'),
      fr: [
        'Vos commandes (ouvrier) :',
        '/clockin · /clockout',
        '/tasks — mes tâches',
        '/taskstart — démarrer',
        '/done — soumettre pour approbation',
        'Photo : done TSK-…',
        '/handover — mes tâches de passation',
        '',
        'Journal bétail : Feed: … · Vaccinate: … · Mortality: … heads=3',
        '',
        'Aussi : question ferme, photo plante/animal, ou brief',
        '/language — langue',
      ].join('\n'),
      yo: [
        'Àwọn àṣẹ rẹ (òṣìṣẹ́ oko):',
        '/clockin · /clockout',
        '/tasks — iṣẹ́ mi',
        '/taskstart — bẹ̀rẹ̀ iṣẹ́',
        '/done — fi sílẹ̀ fún ìfọwọ́sí',
        '/handover — iṣẹ́ ìfísílẹ̀ mi',
        '',
        'Àkọsílẹ̀ ẹran: Feed: … · Vaccinate: … · Mortality: … heads=3',
        '',
        'Pẹ̀lú: béèrè nípa oko, fi fọ́tò ránṣẹ́, tàbí brief',
        '/language — èdè',
      ].join('\n'),
      pcm: [
        'Your commands (field worker):',
        '/clockin · /clockout',
        '/tasks — my tasks',
        '/taskstart — start task',
        '/done — submit for approval',
        'Photo caption: done TSK-…',
        '/handover — my handover tasks',
        '',
        'Livestock log: Feed: … · Vaccinate: … · Mortality: … heads=3',
        '',
        'Also: ask farm question, send photo, or type brief',
        '/language — change language',
      ].join('\n'),
    })
  }

  if (role === 'sales') {
    return msg(locale, {
      en: [
        'Your commands (sales):',
        '/clockin · /clockout',
        '/orders — order help',
        '/confirm · /dispatch · /delivered · /cancel TRV-ORD-…',
        '/lots · pack LOT-… · /printqr [LOT] — box labels',
        '',
        'Also: ask a question, send a photo, or type brief',
        '/language — change reply language',
      ].join('\n'),
      fr: [
        'Vos commandes (ventes) :',
        '/clockin · /clockout',
        '/orders — aide commandes',
        '/confirm · /dispatch · /delivered · /cancel',
        '/lots · pack LOT-… · /printqr — étiquettes',
        '',
        'Aussi : question, photo, ou brief',
        '/language — langue',
      ].join('\n'),
      yo: [
        'Àwọn àṣẹ rẹ (títà):',
        '/clockin · /clockout',
        '/orders — ìrànlọ́wọ́ àṣẹ',
        '/confirm · /dispatch · /delivered · /cancel',
        '/lots · pack LOT-… · /printqr',
        '',
        'Pẹ̀lú: béèrè, fọ́tò, tàbí brief',
        '/language — èdè',
      ].join('\n'),
      pcm: [
        'Your commands (sales):',
        '/clockin · /clockout',
        '/orders — order help',
        '/confirm · /dispatch · /delivered · /cancel',
        '/lots · pack LOT-… · /printqr',
        '',
        'Also: ask question, send photo, or brief',
        '/language — change language',
      ].join('\n'),
    })
  }

  const title =
    role === 'owner'
      ? msg(locale, {
          en: 'Your commands (admin):',
          fr: 'Vos commandes (admin) :',
          yo: 'Àwọn àṣẹ rẹ (admin):',
          pcm: 'Your commands (admin):',
        })
      : msg(locale, {
          en: 'Your commands (supervisor):',
          fr: 'Vos commandes (superviseur) :',
          yo: 'Àwọn àṣẹ rẹ (alábòójútó):',
          pcm: 'Your commands (supervisor):',
        })

  return [
    title,
    msg(locale, {
      en: [
        '/clockin · /clockout',
        '/approve · /reject — tasks awaiting approval',
        '/orders · /confirm · /dispatch · /delivered · /cancel',
        '/lots · pack LOT-… · /printqr [LOT]',
        '/handover — checklist progress',
        '',
        'Draft then Confirm (Telegram buttons / WhatsApp: CONFIRM or CANCEL):',
        'Create task: Count coconut in Block 2',
        'Census: Block 2 crop=coconut count=120',
        'Asset count: Wheelbarrow available=2 damaged=0',
        'Crop: Block 2 type=plantain planted=2026-07-19',
        'Livestock: Noiler A species=noiler heads=200',
        'Stock: Feed bags delta=-2 reason=used',
        'Opening count: Feed bags=50',
        'Ack low stock',
        'Create zone: North Field',
        'Create plot: Block 2 zone=North Field',
        'Verify LOT-… · Reject LOT-…',
        'Feed: Noiler A · Vaccinate: … · Mortality: Noiler A heads=3',
        '',
        'Also: ask a farm question, send a photo, or type brief',
        '/language — change reply language',
      ].join('\n'),
      fr: [
        '/clockin · /clockout',
        '/approve · /reject — tâches en attente',
        '/orders · /confirm · /dispatch · /delivered · /cancel',
        '/lots · pack LOT-… · /printqr',
        '/handover — passation',
        '',
        'Brouillons (Confirmer / Annuler) :',
        'Create task: … · Census: … · Asset count: …',
        'Crop: … · Livestock: …',
        'Stock: … · Opening count: … · Ack low stock',
        'Create zone: … · Create plot: … zone=…',
        'Verify LOT-… · Reject LOT-…',
        'Feed: … · Vaccinate: … · Mortality: … heads=3',
        '',
        'Aussi : question, photo, ou brief',
        '/language — langue',
      ].join('\n'),
      yo: [
        '/clockin · /clockout',
        '/approve · /reject — iṣẹ́ tó ń dúró',
        '/orders · /confirm · /dispatch · /delivered · /cancel',
        '/lots · pack · /printqr',
        '/handover',
        '',
        'Àkọsílẹ̀ (Confirm / Cancel):',
        'Create task: … · Census: … · Asset count: …',
        'Crop: … · Livestock: … · Stock: …',
        'Create zone/plot · Verify LOT · Feed/Vaccinate/Mortality',
        '',
        'Pẹ̀lú: béèrè, fọ́tò, tàbí brief',
        '/language — èdè',
      ].join('\n'),
      pcm: [
        '/clockin · /clockout',
        '/approve · /reject — tasks wey dey wait',
        '/orders · /confirm · /dispatch · /delivered · /cancel',
        '/lots · pack · /printqr',
        '/handover',
        '',
        'Draft den Confirm (WhatsApp: CONFIRM / CANCEL):',
        'Create task: … · Census: … · Asset count: …',
        'Crop: … · Livestock: …',
        'Stock: … · Opening count: … · Ack low stock',
        'Create zone: … · Create plot: … zone=…',
        'Verify LOT-… · Reject LOT-…',
        'Feed: … · Vaccinate: … · Mortality: … heads=3',
        '',
        'Also: ask question, send photo, or brief',
        '/language — change language',
      ].join('\n'),
    }),
  ].join('\n')
}
