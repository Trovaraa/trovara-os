import type { AppLocale } from '@/i18n'
import type { UserRole } from '@/stores/auth'

export type PageGuide = {
  summary: string
  actions: string[]
}

export type RoleGuide = {
  title: string
  summary: string
  duties: string[]
}

export type OnboardingCopy = {
  welcome: (name: string) => string
  welcomeBody: string
  languagePrompt: string
  assignedRole: string
  roleHeading: string
  roleBody: string
  yourPages: string
  pagesBody: string
  basicsTitle: string
  basics: string[]
  readyTitle: string
  readyBody: string
  help: string
  pageHelp: string
  pageHelpBody: string
  /** Short page-help lead: “As a Field worker, follow the steps below for this page.” */
  pageRoleLead: (roleTitle: string) => string
  fullGuide: string
  start: string
  next: string
  back: string
  finish: string
  skip: string
  close: string
  step: (current: number, total: number) => string
  roles: Record<UserRole, RoleGuide>
  pages: Record<string, PageGuide>
  rolePages: Partial<Record<UserRole, Record<string, PageGuide>>>
  fallbackPage: PageGuide
}

const enPages: Record<string, PageGuide> = {
  '/dashboard': {
    summary: 'A quick picture of the farm: work waiting, alerts, low stock, orders, and today’s progress.',
    actions: ['Read the alert cards first.', 'Open a card to see the work behind the number.'],
  },
  '/today': {
    summary: 'The starting point for each workday: clock in, see urgent work, complete attendance, and close the day.',
    actions: ['Clock in before work starts.', 'At clock-out, add an optional note about what you did.'],
  },
  '/advisory': {
    summary: 'Simple farm guidance based on crop stages, poultry timing, weather, and observations from the field.',
    actions: ['Read open recommendations.', 'Record what you see so future guidance improves.'],
  },
  '/worker': {
    summary: 'Your assigned jobs. Start a task, follow its instructions, add evidence, and send it for review.',
    actions: ['Open one task at a time.', 'Mark it done only after the work and evidence are complete.'],
  },
  '/tasks': {
    summary: 'Create, assign, follow, and approve farm work for the team.',
    actions: ['Give every task a clear owner and due date.', 'Review rejected or waiting tasks before creating duplicates.'],
  },
  '/tasks/post-approval': {
    summary: 'A final audit of completed work after approval, used to catch missing evidence or suspicious changes.',
    actions: ['Check the work history and evidence.', 'Escalate anything that does not match the field result.'],
  },
  '/field-reports': {
    summary: 'Report a field observation, problem, loss, hazard, pest, illness, or other issue that needs attention.',
    actions: ['Choose the right farm area.', 'Add a clear note and photo when it helps.'],
  },
  '/crops': {
    summary: 'Keep crop cycles, planting stages, field activity, and harvest records together.',
    actions: ['Open the correct crop cycle before recording work.', 'Keep stage and dates current.'],
  },
  '/livestock': {
    summary: 'Track animal batches, census, feed, health, mortality, and production records.',
    actions: ['Use the correct batch.', 'Record losses and health problems as soon as they happen.'],
  },
  '/inventory': {
    summary: 'Track what enters and leaves the store, using product IDs, units, stock movements, and reconciliation alerts.',
    actions: ['Select the correct SKU and unit.', 'Never change stock to hide a difference; record the real movement.'],
  },
  '/assets': {
    summary: 'Track farm tools, machines, inspections, usage, faults, and maintenance.',
    actions: ['Choose the correct equipment.', 'Report damage before another person uses it.'],
  },
  '/sales': {
    summary: 'Create and follow customer orders from request to confirmation, dispatch, and delivery.',
    actions: ['Confirm product, quantity, and customer before saving.', 'Sales records orders; it cannot change physical stock.'],
  },
  '/support': {
    summary: 'Record customer complaints and support requests, assign an owner, and track the response to closure.',
    actions: ['Write the customer’s words clearly.', 'Record the final resolution before closing the case.'],
  },
  '/products': {
    summary: 'The controlled product catalog: SKU, selling unit, price, and sales availability.',
    actions: ['Use one SKU for one product and pack size.', 'Product details do not replace inventory movements.'],
  },
  '/customer-insights': {
    summary: 'Shows repeated customer questions and themes so the farm can improve products and communication.',
    actions: ['Look for repeated questions.', 'Use the pattern to improve product information or service.'],
  },
  '/whatsapp': {
    summary: 'Manage farm WhatsApp communication, language, templates, and customer conversations.',
    actions: ['Check the recipient before sending.', 'Use the customer’s preferred language when possible.'],
  },
  '/traceability': {
    summary: 'Connect a product lot to its farm source, harvest, quantity, checks, order, and public QR record.',
    actions: ['Use the correct lot code.', 'Do not change a lot after dispatch without a recorded reason.'],
  },
  '/events': {
    summary: 'The audit trail: who changed what, when it changed, and what the record looked like before and after.',
    actions: ['Filter by date, person, or record.', 'Use this page to investigate—not to edit history.'],
  },
  '/ai': {
    summary: 'Ask the farm assistant about work, stock, livestock, or crops, and use photos or voice when typing is difficult.',
    actions: ['Describe the problem plainly.', 'Review any suggested task before confirming it.'],
  },
  '/reports': {
    summary: 'Farm performance summaries for work, production, inventory, sales, and profitability.',
    actions: ['Choose the correct date range.', 'Open the source records before acting on an unusual number.'],
  },
  '/finance': {
    summary: 'Track money connected to farm sales and operations, including payments, expenses, and outstanding balances.',
    actions: ['Use the correct date and reference.', 'Do not mark money as paid until it is confirmed.'],
  },
  '/templates': {
    summary: 'Reusable instructions for work that happens repeatedly, such as feeding, inspection, or field routines.',
    actions: ['Write steps in the order workers should follow.', 'Update the template when the real process changes.'],
  },
  '/zones': {
    summary: 'The farm map structure: zones, plots, and the places where work, crops, animals, and stock belong.',
    actions: ['Use names workers recognize.', 'Avoid creating a second zone for the same place.'],
  },
  '/users': {
    summary: 'Create staff accounts and control what each person can see or do through their assigned role.',
    actions: ['Give the smallest role needed for the job.', 'Deactivate people who no longer work with the farm.'],
  },
  '/settings': {
    summary: 'Change your language, appearance, notifications, security, and allowed farm configuration.',
    actions: ['Choose the language you understand best.', 'Only administrators should change farm-wide settings.'],
  },
  '/settings/security': {
    summary: 'Protect the account with password and two-step verification settings.',
    actions: ['Use a password you do not reuse elsewhere.', 'Keep recovery details in a safe place.'],
  },
}

const enRolePages: OnboardingCopy['rolePages'] = {
  owner: {
    '/today': {
      summary: 'Your daily control room for farm-wide alerts, approvals, exceptions, and the end-of-day position. Administrators do not clock in or out.',
      actions: ['Review urgent exceptions and work awaiting approval.', 'Check the day-close summary before making farm-wide decisions.'],
    },
  },
  supervisor: {
    '/today': {
      summary: 'Your operations desk for coordinating today’s work, checking field exceptions, and keeping the team moving. Supervisors do not clock in or out.',
      actions: ['Review urgent work, worker reports, and attendance exceptions.', 'Approve completed work or send it back with a clear reason.'],
    },
  },
  field_worker: {
    '/today': {
      summary: 'Your workday starts here. Clock in, see what needs attention, then clock out when you finish.',
      actions: [
        'Clock in before you start field work.',
        'Read any urgent notes, then open My Tasks for the jobs assigned to you.',
        'At clock-out, add a short note about what you did if it helps your supervisor.',
      ],
    },
    '/advisory': {
      summary: 'Guidance for the crops and birds you work with. Use it to know what to check, then report what you actually see.',
      actions: [
        'Read open recommendations that match your plots or houses.',
        'Follow the safe steps shown; ask a supervisor if anything is unclear.',
        'Record an observation when the field looks different from the advice.',
      ],
    },
    '/worker': {
      summary: 'These are the jobs assigned to you. Open one task, do the work, add proof, and send it for review.',
      actions: [
        'Start only the task you are ready to finish.',
        'Follow the checklist or instructions on the task.',
        'Add a photo or note as proof, then mark it done for your supervisor to check.',
      ],
    },
    '/field-reports': {
      summary: 'Use this when you see a problem, pest, illness, hazard, loss, or anything that needs a supervisor’s attention.',
      actions: [
        'Choose the correct farm area or plot.',
        'Describe what you saw in plain words and add a photo when it helps.',
        'Send urgent reports promptly—do not wait until the end of the day.',
      ],
    },
    '/settings': {
      summary: 'Your personal settings only: language, appearance, notifications, and password. You cannot change farm-wide setup here.',
      actions: [
        'Choose the language you understand best.',
        'Update your password if you need a safer one.',
        'Ask a supervisor for any farm-wide change.',
      ],
    },
    '/assets': {
      summary: 'When you use farm tools or machines, record usage and report damage so the next person stays safe.',
      actions: [
        'Select the exact tool or machine you used.',
        'Report a fault or damage before handing it to someone else.',
        'Do not mark equipment as fine if it is broken.',
      ],
    },
    '/traceability': {
      summary: 'Harvest and lot records link what you picked or packed to the farm source. Enter only what you measured.',
      actions: [
        'Use the correct lot or harvest record you were told to work on.',
        'Enter the real quantity and quality checks you completed.',
        'Tell a supervisor immediately if a label, weight, or source looks wrong.',
      ],
    },
  },
  sales: {
    '/today': {
      summary: 'Your daily sales queue for pending orders, customer follow-ups, complaints, payments, and deliveries. Sales staff do not clock in or out here.',
      actions: ['Start with orders and customer issues that need action.', 'Confirm payment and delivery updates without changing physical stock.'],
    },
  },
}

const pcmPages: Record<string, PageGuide> = {
  '/dashboard': { summary: 'This page show farm summary: work wey remain, warning, low stock, order and today progress.', actions: ['Check warning cards first.', 'Open any card to see the work inside.'] },
  '/today': { summary: 'Start every workday here: clock in, see urgent work, take attendance and close the day.', actions: ['Clock in before work start.', 'When you clock out, you fit add wetin you do; e no compulsory.'] },
  '/advisory': { summary: 'Simple farm advice from crop stage, chicken timing, weather and wetin workers report.', actions: ['Read advice wey still open.', 'Record wetin you see for field.'] },
  '/worker': { summary: 'Na your own assigned work dey here. Start am, follow instruction, add proof and send am for check.', actions: ['Open one task at a time.', 'Mark am done only when work and proof complete.'] },
  '/tasks': { summary: 'Create, give, follow and approve work for farm team.', actions: ['Give every task person and due date.', 'Check rejected or waiting work before you create another one.'] },
  '/tasks/post-approval': { summary: 'Final check after work don approve, to find missing proof or strange change.', actions: ['Check history and proof.', 'Report anything wey no match field result.'] },
  '/field-reports': { summary: 'Report wetin you see for field: problem, loss, danger, pest, sickness or any issue.', actions: ['Choose correct farm area.', 'Add clear note and picture if e go help.'] },
  '/crops': { summary: 'Keep crop cycle, planting stage, field work and harvest record together.', actions: ['Open correct crop cycle.', 'Keep stage and date correct.'] },
  '/livestock': { summary: 'Track animal batch, count, feed, health, death and production.', actions: ['Use correct batch.', 'Record sickness or loss quickly.'] },
  '/inventory': { summary: 'Track everything wey enter or commot from store with SKU, unit and leakage warning.', actions: ['Choose correct SKU and unit.', 'Record real movement; no change stock to hide difference.'] },
  '/assets': { summary: 'Track tools and machines, who use dem, fault, inspection and repair.', actions: ['Choose correct equipment.', 'Report damage before another person use am.'] },
  '/sales': { summary: 'Record customer order from request reach confirmation, dispatch and delivery.', actions: ['Confirm product, amount and customer.', 'Sales fit record order but sales no fit change physical stock.'] },
  '/support': { summary: 'Record customer complaint or help request and follow am until e close.', actions: ['Write wetin customer talk clearly.', 'Record how una solve am before closing.'] },
  '/products': { summary: 'Official product list: SKU, selling unit, price and whether sales open.', actions: ['One SKU must mean one product and pack size.', 'Product page no be where stock movement happen.'] },
  '/customer-insights': { summary: 'Show questions wey customers dey ask many times so farm fit improve.', actions: ['Look for repeated question.', 'Use am improve product information or service.'] },
  '/whatsapp': { summary: 'Manage farm WhatsApp message, language, template and customer talk.', actions: ['Check person before you send.', 'Use customer language if you fit.'] },
  '/traceability': { summary: 'Join product lot with farm source, harvest, amount, checks, order and QR record.', actions: ['Use correct lot code.', 'No change dispatched lot without recorded reason.'] },
  '/events': { summary: 'Audit history: who change wetin, when dem change am and old/new record.', actions: ['Filter by date, person or record.', 'Use am investigate; no be place to edit history.'] },
  '/ai': { summary: 'Ask farm assistant about work, stock, animal or crop. You fit use photo or voice too.', actions: ['Explain problem with simple words.', 'Check suggested task before you confirm am.'] },
  '/reports': { summary: 'Farm summary for work, production, stock, sales and profit.', actions: ['Choose correct date range.', 'Check source record if any number look strange.'] },
  '/finance': { summary: 'Track farm money: payment, expense and money wey customer never pay.', actions: ['Use correct date and reference.', 'No mark paid until money confirm.'] },
  '/templates': { summary: 'Instruction wey farm fit use again for feeding, inspection or regular work.', actions: ['Write steps for correct order.', 'Update am when real process change.'] },
  '/zones': { summary: 'Farm place setup: zones, plots and where work, crop, animal and stock belong.', actions: ['Use name workers know.', 'No create two zones for same place.'] },
  '/users': { summary: 'Create staff account and control wetin each role fit see or do.', actions: ['Give only access wey person need.', 'Deactivate person wey no dey work with farm again.'] },
  '/settings': { summary: 'Change language, look, notification, security and farm setup.', actions: ['Choose language wey you understand pass.', 'Only admin suppose change farm-wide setting.'] },
  '/settings/security': { summary: 'Protect account with password and two-step verification.', actions: ['Use password wey you no use somewhere else.', 'Keep recovery details for safe place.'] },
}

const pcmRolePages: OnboardingCopy['rolePages'] = {
  owner: { '/today': { summary: 'Na your daily control page for farm warning, approval, exception and day-close summary. Admin no need clock in or clock out.', actions: ['Check urgent issue and work wey dey wait for approval.', 'Check day-close summary before you make farm-wide decision.'] } },
  supervisor: { '/today': { summary: 'Na here you arrange today work, check field issue and help team move. Supervisor no need clock in or clock out.', actions: ['Check urgent work, worker report and attendance problem.', 'Approve completed work or return am with clear reason.'] } },
  field_worker: {
    '/today': {
      summary: 'Your workday start here. Clock in, see wetin need attention, then clock out when you finish.',
      actions: [
        'Clock in before you start field work.',
        'Read any urgent note, then open My Tasks for work dem assign you.',
        'When you clock out, you fit add short note about wetin you do if e go help supervisor.',
      ],
    },
    '/advisory': {
      summary: 'Advice for crop and bird wey you dey work with. Use am know wetin to check, then report wetin you really see.',
      actions: [
        'Read open advice wey match your plot or house.',
        'Follow safe steps; ask supervisor if anything no clear.',
        'Record observation if field look different from the advice.',
      ],
    },
    '/worker': {
      summary: 'Na your own assigned jobs dey here. Open one task, do the work, add proof, send am for check.',
      actions: [
        'Start only the task wey you ready to finish.',
        'Follow checklist or instruction for the task.',
        'Add photo or note as proof, then mark am done for supervisor to check.',
      ],
    },
    '/field-reports': {
      summary: 'Use this page when you see problem, pest, sickness, danger, loss or anything wey supervisor need know.',
      actions: [
        'Choose correct farm area or plot.',
        'Talk wetin you see with clear words and add photo if e go help.',
        'Send urgent report quick—no wait till day finish.',
      ],
    },
    '/settings': {
      summary: 'Na your personal setting only: language, look, notification and password. You no fit change farm-wide setup here.',
      actions: [
        'Choose language wey you understand pass.',
        'Update password if you need safer one.',
        'Ask supervisor for any farm-wide change.',
      ],
    },
    '/assets': {
      summary: 'When you use farm tool or machine, record am and report damage so next person go safe.',
      actions: [
        'Select the exact tool or machine wey you use.',
        'Report fault or damage before another person use am.',
        'No mark equipment as fine if e don spoil.',
      ],
    },
    '/traceability': {
      summary: 'Harvest and lot record join wetin you pick or pack with farm source. Enter only wetin you measure.',
      actions: [
        'Use correct lot or harvest record wey dem tell you to work on.',
        'Enter real quantity and quality check wey you complete.',
        'Tell supervisor sharp if label, weight or source look wrong.',
      ],
    },
  },
  sales: { '/today': { summary: 'Na your daily sales page for pending order, customer follow-up, complaint, payment and delivery. Sales no need clock in or clock out here.', actions: ['Start with order and customer issue wey need action.', 'Confirm payment and delivery without changing physical stock.'] } },
}

const yoPages: Record<string, PageGuide> = {
  '/dashboard': { summary: 'Àkótán oko: iṣẹ́ tó kù, ìkìlọ̀, ọjà tó ń tán, àwọn ọ̀dà àti ìlọsíwájú òní.', actions: ['Ka àwọn ìkìlọ̀ kọ́kọ́.', 'Ṣí káàdì kan láti rí iṣẹ́ tó wà nínú rẹ̀.'] },
  '/today': { summary: 'Ibí ni ọjọ́ iṣẹ́ ti bẹ̀rẹ̀: wọlé sí iṣẹ́, wo iṣẹ́ pàtàkì, ṣe àkọsílẹ̀ wíwà, kí o sì parí ọjọ́.', actions: ['Wọlé sí iṣẹ́ kí iṣẹ́ tó bẹ̀rẹ̀.', 'Nígbà tí o bá ń jáde, o lè kọ ohun tí o ṣe; kò pọn dandan.'] },
  '/advisory': { summary: 'Ìmọ̀ràn oko tó rọrùn láti ìpele irugbin, àkókò adìẹ, ojú-ọjọ́ àti àkíyèsí oko.', actions: ['Ka ìmọ̀ràn tó ṣì ṣí.', 'Kọ ohun tí o rí ní oko.'] },
  '/worker': { summary: 'Àwọn iṣẹ́ tí a yàn fún ọ. Bẹ̀rẹ̀ iṣẹ́, tẹ̀lé ìtọ́sọ́nà, fi ẹ̀rí kún un, kí o sì rán án fún àyẹ̀wò.', actions: ['Ṣí iṣẹ́ kan lẹ́ẹ̀kan.', 'Má ṣe samisi pé ó parí títí iṣẹ́ àti ẹ̀rí fi pé.'] },
  '/tasks': { summary: 'Ṣẹ̀dá, yan, tọ́pa àti fọwọ́sí iṣẹ́ fún ẹgbẹ́ oko.', actions: ['Fi ẹni tó ni iṣẹ́ àti ọjọ́ ìparí sí gbogbo iṣẹ́.', 'Ṣàyẹ̀wò iṣẹ́ tí a kọ̀ tàbí tó ń dúró kí o tó ṣẹ̀dá tuntun.'] },
  '/tasks/post-approval': { summary: 'Àyẹ̀wò ìkẹyìn lẹ́yìn ìfọwọ́sí láti rí ẹ̀rí tó sọnù tàbí ìyípadà àjèjì.', actions: ['Ṣàyẹ̀wò ìtàn iṣẹ́ àti ẹ̀rí.', 'Jábọ̀ ohun tí kò bá abajade oko mu.'] },
  '/field-reports': { summary: 'Jábọ̀ àkíyèsí oko, ìṣòro, àdánù, ewu, kòkòrò tàbí àìsàn.', actions: ['Yan agbègbè oko tó tọ́.', 'Kọ àlàyé kedere, kí o fi fọ́tò kún un bí ó bá wúlò.'] },
  '/crops': { summary: 'Pa ìyíká irugbin, ìpele gbígbìn, iṣẹ́ oko àti ìkórè mọ́ pọ̀.', actions: ['Ṣí ìyíká irugbin tó tọ́.', 'Mú ìpele àti ọjọ́ ṣiṣẹ́ déédéé.'] },
  '/livestock': { summary: 'Tọ́pa ẹgbẹ́ ẹranko, iye, oúnjẹ, ìlera, ikú àti iṣelọpọ.', actions: ['Lo ẹgbẹ́ tó tọ́.', 'Kọ àìsàn tàbí àdánù sílẹ̀ kíákíá.'] },
  '/inventory': { summary: 'Tọ́pa ohun tó wọlé àti tó jáde ní ilé ìpamọ́ pẹ̀lú SKU, ìwọ̀n àti ìkìlọ̀ ìyàtọ̀.', actions: ['Yan SKU àti ìwọ̀n tó tọ́.', 'Kọ ìrìn ọjà gidi; má ṣe yí stock padà láti bo ìyàtọ̀.'] },
  '/assets': { summary: 'Tọ́pa irinṣẹ́ àti ẹ̀rọ, lílò, àbùkù, àyẹ̀wò àti àtúnṣe.', actions: ['Yan ohun èlò tó tọ́.', 'Jábọ̀ àbùkù kí ẹlòmíràn tó lò ó.'] },
  '/sales': { summary: 'Kọ ọ̀dà oníbàárà láti ìbéèrè dé ìfọwọ́sí, fífi ránṣẹ́ àti ìfijiṣẹ́.', actions: ['Jẹ́rìí ọja, iye àti oníbàárà.', 'Sales lè kọ ọ̀dà, ṣùgbọ́n kò lè yí stock gidi padà.'] },
  '/support': { summary: 'Kọ ẹ̀dùn oníbàárà tàbí ìbéèrè ìrànlọ́wọ́, kí o sì tọ́pa rẹ̀ títí yóò fi parí.', actions: ['Kọ ọ̀rọ̀ oníbàárà kedere.', 'Kọ bí a ṣe yanjú rẹ̀ kí o tó pa á.'] },
  '/products': { summary: 'Àtòjọ ọja àṣẹ: SKU, ìwọ̀n títà, iye owó àti bóyá títà ṣí.', actions: ['SKU kan gbọ́dọ̀ dúró fún ọja àti ìdì kan.', 'Ojú-ewé ọja kì í ṣe ibi ìrìn stock.'] },
  '/customer-insights': { summary: 'Ó fi àwọn ìbéèrè tí oníbàárà ń tún béèrè hàn kí oko lè mú ìṣẹ́ àti alaye dára.', actions: ['Wá ìbéèrè tó ń tún padà.', 'Lo àpẹẹrẹ náà láti mú iṣẹ́ dára.'] },
  '/whatsapp': { summary: 'Ṣàkóso ìfiranṣẹ́ WhatsApp oko, èdè, àwòrán ìfiranṣẹ́ àti ìjíròrò oníbàárà.', actions: ['Ṣàyẹ̀wò ẹni tí o fẹ́ ránṣẹ́ sí.', 'Lo èdè tí oníbàárà fẹ́ bí ó bá ṣeé ṣe.'] },
  '/traceability': { summary: 'So lot ọja pọ̀ mọ́ orísun oko, ìkórè, iye, àyẹ̀wò, ọ̀dà àti àkọsílẹ̀ QR.', actions: ['Lo kóòdù lot tó tọ́.', 'Má yí lot tí a ti rán padà láìkọ ìdí.'] },
  '/events': { summary: 'Ìtàn àyẹ̀wò: ẹni tó yí nǹkan padà, ìgbà tó ṣe é, àti àkọsílẹ̀ àtijọ́/tuntun.', actions: ['Ṣàlẹ̀mọ́ pẹ̀lú ọjọ́, ènìyàn tàbí àkọsílẹ̀.', 'Lo ó fún ìwádìí, kì í ṣe fún pípa ìtàn padà.'] },
  '/ai': { summary: 'Béèrè lọ́wọ́ olùrànlọ́wọ́ oko nípa iṣẹ́, stock, ẹranko tàbí irugbin; o tún lè lo fọ́tò tàbí ohùn.', actions: ['Ṣàlàyé ìṣòro ní ọ̀rọ̀ rọrùn.', 'Ṣàyẹ̀wò iṣẹ́ tí ó dábàá kí o tó fọwọ́sí.'] },
  '/reports': { summary: 'Àkótán iṣẹ́ oko, iṣelọpọ, stock, títà àti èrè.', actions: ['Yan àkókò ọjọ́ tó tọ́.', 'Ṣàyẹ̀wò àkọsílẹ̀ orísun bí nọ́mbà kan bá dàbí àjèjì.'] },
  '/finance': { summary: 'Tọ́pa owó oko: ìsanwó, ìnáwó àti gbèsè oníbàárà.', actions: ['Lo ọjọ́ àti nọ́mbà ìtọ́kasí tó tọ́.', 'Má samisi pé a san títí owó fi dájú.'] },
  '/templates': { summary: 'Ìtọ́sọ́nà tí a lè tún lò fún fífún ẹranko, àyẹ̀wò tàbí iṣẹ́ àtúnṣe.', actions: ['Kọ àwọn ìgbésẹ̀ ní ìtẹ̀sí tó tọ́.', 'Ṣe àtúnṣe rẹ̀ nígbà tí iṣẹ́ gidi bá yí padà.'] },
  '/zones': { summary: 'Ìṣètò ibi oko: agbègbè, pápá àti ibi tí iṣẹ́, irugbin, ẹranko àti stock wà.', actions: ['Lo orúkọ tí àwọn òṣìṣẹ́ mọ̀.', 'Má ṣẹ̀dá agbègbè méjì fún ibi kan náà.'] },
  '/users': { summary: 'Ṣẹ̀dá àkọọ́lẹ̀ òṣìṣẹ́, kí o sì ṣàkóso ohun tí ipa kọ̀ọ̀kan lè rí tàbí ṣe.', actions: ['Fún ènìyàn ní àṣẹ tó kéré tó yẹ fún iṣẹ́ rẹ̀.', 'Pa àkọọ́lẹ̀ ẹni tí kò ṣiṣẹ́ mọ́.'] },
  '/settings': { summary: 'Yí èdè, àwọ̀, ìkìlọ̀, ààbò àti ìṣètò oko padà.', actions: ['Yan èdè tí o lóye jù.', 'Admin nìkan ló yẹ kí ó yí ìṣètò gbogbo oko padà.'] },
  '/settings/security': { summary: 'Dáàbò bo àkọọ́lẹ̀ pẹ̀lú ọ̀rọ̀ aṣínà àti ìjẹ́rìí ìgbésẹ̀ méjì.', actions: ['Lo ọ̀rọ̀ aṣínà tí o kò lò ní ibòmíràn.', 'Pa alaye ìmúpadàbọ̀ sí ibi ààbò.'] },
}

const yoRolePages: OnboardingCopy['rolePages'] = {
  owner: { '/today': { summary: 'Ibí ni o ti ń ṣàkóso ìkìlọ̀ gbogbo oko, ìfọwọ́sí, ìṣòro àti àkótán ọjọ́. Olùṣàkóso kò nílò láti wọlé tàbí jáde níbi iṣẹ́.', actions: ['Ṣàyẹ̀wò ìṣòro pàtàkì àti iṣẹ́ tó ń dúró fún ìfọwọ́sí.', 'Ka àkótán ìparí ọjọ́ kí o tó ṣe ìpinnu gbogbo oko.'] } },
  supervisor: { '/today': { summary: 'Ibí ni o ti ń ṣètò iṣẹ́ òní, ṣàyẹ̀wò ìṣòro oko, kí o sì jẹ́ kí ẹgbẹ́ tẹ̀síwájú. Alábòójútó kò nílò láti wọlé tàbí jáde níbi iṣẹ́.', actions: ['Ṣàyẹ̀wò iṣẹ́ pàtàkì, ìròyìn òṣìṣẹ́ àti ìṣòro wíwà.', 'Fọwọ́sí iṣẹ́ tó pé tàbí dá a padà pẹ̀lú ìdí kedere.'] } },
  field_worker: {
    '/today': {
      summary: 'Ibí ni ọjọ́ iṣẹ́ rẹ ti bẹ̀rẹ̀. Wọlé sí iṣẹ́, wo ohun tó nílò àkíyèsí, kí o sì jáde nígbà tí o bá parí.',
      actions: [
        'Wọlé sí iṣẹ́ kí iṣẹ́ oko tó bẹ̀rẹ̀.',
        'Ka àkíyèsí pàtàkì, kí o sì ṣí Àwọn iṣẹ́ mi fún iṣẹ́ tí a yàn fún ọ.',
        'Nígbà tí o bá ń jáde, o lè kọ àkótán kukuru nípa ohun tí o ṣe bí ó bá wúlò fún supervisor.',
      ],
    },
    '/advisory': {
      summary: 'Ìmọ̀ràn fún irugbin àti ẹyẹ tí o ń ṣiṣẹ́ lórí wọn. Lo ó láti mọ ohun tí o yẹ kí o ṣàyẹ̀wò, kí o sì jábọ̀ ohun tí o rí gangan.',
      actions: [
        'Ka ìmọ̀ràn tó ṣì ṣí tí ó bá pápá tàbí ilé rẹ mu.',
        'Tẹ̀lé àwọn ìgbésẹ̀ ààbò; béèrè lọ́wọ́ supervisor bí ohunkóhun kò bá yé ọ.',
        'Kọ àkíyèsí sílẹ̀ nígbà tí oko bá yàtọ̀ sí ìmọ̀ràn náà.',
      ],
    },
    '/worker': {
      summary: 'Àwọn iṣẹ́ tí a yàn fún ọ nìyí. Ṣí iṣẹ́ kan, ṣe é, fi ẹ̀rí kún un, kí o sì rán án fún àyẹ̀wò.',
      actions: [
        'Bẹ̀rẹ̀ iṣẹ́ tí o ti ṣetán láti parí nìkan.',
        'Tẹ̀lé àtòjọ-ìṣàyẹ̀wò tàbí ìtọ́sọ́nà lórí iṣẹ́ náà.',
        'Fi fọ́tò tàbí àkọsílẹ̀ kún un gẹ́gẹ́ bí ẹ̀rí, kí o sì samisi pé ó parí kí supervisor lè ṣàyẹ̀wò.',
      ],
    },
    '/field-reports': {
      summary: 'Lo ojú-ewé yìí nígbà tí o bá rí ìṣòro, kòkòrò, àìsàn, ewu, àdánù tàbí ohunkóhun tí supervisor nílò láti mọ̀.',
      actions: [
        'Yan agbègbè oko tàbí pápá tó tọ́.',
        'Ṣàlàyé ohun tí o rí ní ọ̀rọ̀ kedere, kí o fi fọ́tò kún un bí ó bá wúlò.',
        'Fi ìròyìn pàtàkì ránṣẹ́ kíákíá—má ṣe dúró títí ọjọ́ fi parí.',
      ],
    },
    '/settings': {
      summary: 'Ìṣètò ti ara ẹ nìkan: èdè, àwọ̀, ìkìlọ̀ àti ọ̀rọ̀ aṣínà. O kò lè yí ìṣètò gbogbo oko padà níbi.',
      actions: [
        'Yan èdè tí o lóye jù.',
        'Ṣe àtúnṣe ọ̀rọ̀ aṣínà rẹ bí o bá nílò èyí tó ní ààbò ju.',
        'Béèrè lọ́wọ́ supervisor fún ìyípadà gbogbo oko.',
      ],
    },
    '/assets': {
      summary: 'Nígbà tí o bá lo irinṣẹ́ tàbí ẹ̀rọ oko, kọ lílò rẹ̀ sílẹ̀, kí o sì jábọ̀ àbùkù kí ẹni tó tẹ̀lé ọ lè wà ní ààbò.',
      actions: [
        'Yan irinṣẹ́ tàbí ẹ̀rọ gangan tí o lò.',
        'Jábọ̀ àbùkù tàbí ibi-kíkùn kí ẹlòmíràn tó lò ó.',
        'Má samisi pé ohun èlò wà ní àlàáfíà bí ó bá ti bàjẹ́.',
      ],
    },
    '/traceability': {
      summary: 'Àkọsílẹ̀ ìkórè àti lot so ohun tí o kó tàbí tí o dì pọ̀ mọ́ orísun oko. Kọ ohun tí o wọn nìkan.',
      actions: [
        'Lo lot tàbí àkọsílẹ̀ ìkórè tó tọ́ tí wọ́n sọ fún ọ.',
        'Kọ iye gidi àti àyẹ̀wò didára tí o ṣe.',
        'Sọ fún supervisor lẹ́sẹ̀kẹsẹ̀ bí àmì, ìwọ̀n tàbí orísun bá dàbí èyí tí kò tọ́.',
      ],
    },
  },
  sales: { '/today': { summary: 'Ibí ni títà ti ń rí ọ̀dà tó ń dúró, ìtọ́pa oníbàárà, ẹ̀dùn, ìsanwó àti ìfijiṣẹ́. Ẹgbẹ́ títà kò nílò láti wọlé tàbí jáde níbi.', actions: ['Bẹ̀rẹ̀ pẹ̀lú ọ̀dà àti ìṣòro oníbàárà tó nílò ìgbésẹ̀.', 'Jẹ́rìí ìsanwó àti ìfijiṣẹ́ láìyí stock gidi padà.'] } },
}

const frPages: Record<string, PageGuide> = {
  '/dashboard': { summary: 'Vue rapide de la ferme : tâches en attente, alertes, stock faible, commandes et progrès du jour.', actions: ['Lisez d’abord les alertes.', 'Ouvrez une carte pour voir les éléments concernés.'] },
  '/today': { summary: 'Point de départ de la journée : arrivée, urgences, présence et clôture de journée.', actions: ['Pointez avant de commencer.', 'Au départ, ajoutez si vous voulez une note sur le travail réalisé.'] },
  '/advisory': { summary: 'Conseils simples selon les cultures, le cycle des volailles, la météo et les observations du terrain.', actions: ['Lisez les recommandations ouvertes.', 'Notez ce que vous observez sur le terrain.'] },
  '/worker': { summary: 'Vos tâches assignées. Démarrez, suivez les consignes, ajoutez une preuve et envoyez pour contrôle.', actions: ['Traitez une tâche à la fois.', 'Terminez-la seulement quand le travail et la preuve sont complets.'] },
  '/tasks': { summary: 'Créez, assignez, suivez et approuvez le travail de l’équipe.', actions: ['Ajoutez un responsable et une échéance.', 'Vérifiez les tâches rejetées ou en attente avant d’en créer une autre.'] },
  '/tasks/post-approval': { summary: 'Contrôle final du travail approuvé pour repérer une preuve manquante ou un changement suspect.', actions: ['Vérifiez l’historique et les preuves.', 'Signalez ce qui ne correspond pas au résultat terrain.'] },
  '/field-reports': { summary: 'Signalez une observation, un problème, une perte, un danger, un ravageur ou une maladie.', actions: ['Choisissez la bonne zone.', 'Ajoutez une note claire et une photo si utile.'] },
  '/crops': { summary: 'Regroupe les cycles, stades, activités et récoltes des cultures.', actions: ['Ouvrez le bon cycle.', 'Gardez les stades et les dates à jour.'] },
  '/livestock': { summary: 'Suivez les lots d’animaux, les effectifs, l’alimentation, la santé, la mortalité et la production.', actions: ['Utilisez le bon lot.', 'Enregistrez rapidement toute maladie ou perte.'] },
  '/inventory': { summary: 'Suivez les entrées et sorties avec SKU, unité et alertes de rapprochement.', actions: ['Choisissez le bon SKU et la bonne unité.', 'Enregistrez le mouvement réel; ne modifiez jamais le stock pour cacher un écart.'] },
  '/assets': { summary: 'Suivez outils et machines, utilisation, inspection, panne et entretien.', actions: ['Choisissez le bon équipement.', 'Signalez une panne avant une nouvelle utilisation.'] },
  '/sales': { summary: 'Suivez les commandes clients de la demande à la confirmation, l’expédition et la livraison.', actions: ['Vérifiez produit, quantité et client.', 'Les ventes enregistrent les commandes mais ne modifient pas le stock physique.'] },
  '/support': { summary: 'Enregistrez les réclamations et demandes d’aide, puis suivez leur résolution.', actions: ['Reprenez clairement les mots du client.', 'Notez la solution avant de fermer le dossier.'] },
  '/products': { summary: 'Catalogue contrôlé : SKU, unité de vente, prix et disponibilité commerciale.', actions: ['Un SKU correspond à un produit et un conditionnement.', 'Le catalogue ne remplace pas les mouvements de stock.'] },
  '/customer-insights': { summary: 'Regroupe les questions fréquentes pour améliorer les produits et la communication.', actions: ['Repérez les questions répétées.', 'Utilisez-les pour améliorer les informations ou le service.'] },
  '/whatsapp': { summary: 'Gérez les messages WhatsApp, les langues, les modèles et les échanges clients.', actions: ['Vérifiez le destinataire.', 'Utilisez si possible la langue préférée du client.'] },
  '/traceability': { summary: 'Relie un lot à sa ferme, sa récolte, sa quantité, ses contrôles, sa commande et son QR public.', actions: ['Utilisez le bon code de lot.', 'Ne modifiez pas un lot expédié sans motif enregistré.'] },
  '/events': { summary: 'Journal d’audit : qui a changé quoi, quand, et les valeurs avant/après.', actions: ['Filtrez par date, personne ou dossier.', 'Utilisez cette page pour enquêter, pas pour modifier l’historique.'] },
  '/ai': { summary: 'Interrogez l’assistant sur le travail, le stock, les animaux ou les cultures, avec texte, voix ou photo.', actions: ['Décrivez simplement le problème.', 'Vérifiez toute tâche proposée avant de la confirmer.'] },
  '/reports': { summary: 'Synthèses du travail, de la production, du stock, des ventes et de la rentabilité.', actions: ['Choisissez la bonne période.', 'Vérifiez les données source avant d’agir sur un chiffre inhabituel.'] },
  '/finance': { summary: 'Suivez paiements, dépenses et soldes liés aux ventes et aux opérations.', actions: ['Utilisez la bonne date et la bonne référence.', 'Ne marquez un paiement reçu qu’après confirmation.'] },
  '/templates': { summary: 'Consignes réutilisables pour l’alimentation, les inspections et les routines.', actions: ['Écrivez les étapes dans l’ordre.', 'Mettez le modèle à jour lorsque le processus change.'] },
  '/zones': { summary: 'Structure des lieux : zones, parcelles et emplacements du travail, des cultures, animaux et stocks.', actions: ['Utilisez des noms connus de l’équipe.', 'Ne créez pas deux zones pour le même lieu.'] },
  '/users': { summary: 'Créez les comptes et contrôlez les accès selon le rôle.', actions: ['Donnez uniquement les droits nécessaires.', 'Désactivez les personnes qui ne travaillent plus avec la ferme.'] },
  '/settings': { summary: 'Modifiez langue, apparence, notifications, sécurité et configuration autorisée.', actions: ['Choisissez la langue la plus claire pour vous.', 'Seuls les administrateurs changent les réglages de toute la ferme.'] },
  '/settings/security': { summary: 'Protégez le compte avec le mot de passe et la vérification en deux étapes.', actions: ['Utilisez un mot de passe unique.', 'Gardez les informations de récupération en lieu sûr.'] },
}

const frRolePages: OnboardingCopy['rolePages'] = {
  owner: { '/today': { summary: 'Votre poste de contrôle quotidien pour les alertes, approbations, exceptions et la clôture de la ferme. Les administrateurs ne pointent pas.', actions: ['Examinez les urgences et le travail en attente d’approbation.', 'Consultez la clôture avant toute décision concernant toute la ferme.'] } },
  supervisor: { '/today': { summary: 'Votre poste d’opérations pour coordonner le travail, contrôler les exceptions et faire avancer l’équipe. Les superviseurs ne pointent pas.', actions: ['Vérifiez le travail urgent, les rapports terrain et les anomalies de présence.', 'Approuvez le travail terminé ou renvoyez-le avec un motif clair.'] } },
  field_worker: {
    '/today': {
      summary: 'Votre journée commence ici. Pointez à l’arrivée, voyez ce qui demande attention, puis pointez au départ.',
      actions: [
        'Pointez avant de commencer le travail au champ.',
        'Lisez les notes urgentes, puis ouvrez Mes tâches pour vos jobs assignés.',
        'Au départ, ajoutez une courte note sur ce que vous avez fait si cela aide le superviseur.',
      ],
    },
    '/advisory': {
      summary: 'Conseils pour les cultures et les volailles dont vous vous occupez. Utilisez-les pour savoir quoi vérifier, puis signalez ce que vous voyez vraiment.',
      actions: [
        'Lisez les recommandations ouvertes qui concernent vos parcelles ou bâtiments.',
        'Suivez les étapes sûres ; demandez au superviseur en cas de doute.',
        'Enregistrez une observation si le terrain diffère du conseil.',
      ],
    },
    '/worker': {
      summary: 'Voici les jobs qui vous sont assignés. Ouvrez une tâche, faites le travail, ajoutez une preuve et envoyez pour contrôle.',
      actions: [
        'Démarrez seulement la tâche que vous pouvez terminer.',
        'Suivez la checklist ou les consignes de la tâche.',
        'Ajoutez une photo ou une note comme preuve, puis marquez-la terminée pour le superviseur.',
      ],
    },
    '/field-reports': {
      summary: 'Utilisez cette page quand vous voyez un problème, un ravageur, une maladie, un danger, une perte ou tout ce qui nécessite l’attention du superviseur.',
      actions: [
        'Choisissez la bonne zone ou parcelle.',
        'Décrivez clairement ce que vous avez vu et ajoutez une photo si utile.',
        'Envoyez les signalements urgents tout de suite—n’attendez pas la fin de la journée.',
      ],
    },
    '/settings': {
      summary: 'Vos réglages personnels seulement : langue, apparence, notifications et mot de passe. Vous ne changez pas la configuration de toute la ferme ici.',
      actions: [
        'Choisissez la langue que vous comprenez le mieux.',
        'Mettez à jour votre mot de passe si besoin.',
        'Demandez au superviseur pour tout changement concernant toute la ferme.',
      ],
    },
    '/assets': {
      summary: 'Quand vous utilisez un outil ou une machine, enregistrez l’usage et signalez tout dégât pour la sécurité de la personne suivante.',
      actions: [
        'Sélectionnez l’outil ou la machine exacte utilisée.',
        'Signalez une panne ou un dégât avant de le passer à quelqu’un d’autre.',
        'Ne marquez pas l’équipement comme bon s’il est cassé.',
      ],
    },
    '/traceability': {
      summary: 'Les fiches de récolte et de lot relient ce que vous avez cueilli ou emballé à la source à la ferme. Saisissez seulement ce que vous avez mesuré.',
      actions: [
        'Utilisez le bon lot ou la bonne fiche de récolte indiquée.',
        'Saisissez la quantité réelle et les contrôles qualité que vous avez faits.',
        'Prévenez immédiatement le superviseur si une étiquette, un poids ou une source semble incorrect.',
      ],
    },
  },
  sales: { '/today': { summary: 'Votre file de vente quotidienne : commandes, suivis clients, réclamations, paiements et livraisons. L’équipe commerciale ne pointe pas ici.', actions: ['Commencez par les commandes et demandes clients urgentes.', 'Confirmez paiements et livraisons sans modifier le stock physique.'] } },
}

const copies: Record<AppLocale, Omit<OnboardingCopy, 'pages' | 'fallbackPage'> & { pages: Record<string, PageGuide>; fallbackPage: PageGuide }> = {
  en: {
    welcome: (name) => `Welcome, ${name}`,
    welcomeBody: 'Trovara OS will guide you. You do not need to know the system before you begin.',
    languagePrompt: 'Choose the language you understand best. The guide and the OS will follow it.',
    assignedRole: 'Your assigned role',
    roleHeading: 'What your role means',
    roleBody: 'Your role controls the pages you can see and the work you are allowed to do.',
    yourPages: 'Your pages, explained',
    pagesBody: 'These are the pages available to your role. You can open Help on any page whenever you forget what it does.',
    basicsTitle: 'Three things to remember',
    basics: ['Use the menu arrow to make the desktop menu smaller or larger.', 'Use the language buttons at any time; your choice is saved to your profile.', 'Tap the Help button on any page for a plain explanation of that page.'],
    readyTitle: 'You are ready to begin',
    readyBody: 'Start with the page your role opens. Read before you save, and ask a supervisor whenever the real farm result does not match the screen.',
    help: 'Help', pageHelp: 'About this page', pageHelpBody: 'Here is what this page is for and the safest way to use it.', pageRoleLead: (roleTitle) => `As a ${roleTitle}, follow the steps below for this page.`, fullGuide: 'Show full guide', start: 'Start guide', next: 'Next', back: 'Back', finish: 'Start using Trovara OS', skip: 'Skip for now', close: 'Close', step: (current, total) => `Step ${current} of ${total}`,
    roles: {
      owner: { title: 'Administrator', summary: 'You oversee the whole farm system and control access, setup, approvals, records, and business reporting.', duties: ['Set up users and farm structure.', 'Review exceptions and approvals.', 'Protect permissions, finance, and audit records.'] },
      supervisor: { title: 'Supervisor', summary: 'You coordinate daily farm work and verify that field records match what really happened.', duties: ['Assign and review work.', 'Check crops, animals, stock, and field reports.', 'Escalate losses, risks, and unusual differences.'] },
      field_worker: { title: 'Field worker', summary: 'You clock in, complete assigned field tasks, report what you observe, and send proof for your supervisor to review.', duties: ['Start each day on Today and clock in.', 'Finish one assigned task at a time with clear proof.', 'Report problems, pests, losses, or hazards as soon as you see them.'] },
      sales: { title: 'Sales', summary: 'You manage customers, orders, complaints, and payments without changing physical farm stock.', duties: ['Record orders and customer details accurately.', 'Follow complaints to resolution.', 'Never adjust inventory quantities.'] },
    },
    pages: enPages,
    rolePages: enRolePages,
    fallbackPage: { summary: 'This page contains a specific Trovara OS function available to your role.', actions: ['Read the page heading and instructions.', 'Ask a supervisor before saving something you do not understand.'] },
  },
  pcm: {
    welcome: (name) => `Welcome, ${name}`,
    welcomeBody: 'Trovara OS go guide you. You no need sabi the system before you start.',
    languagePrompt: 'Choose language wey you understand pass. The guide and OS go follow am.',
    assignedRole: 'Your assigned role', roleHeading: 'Wetin your role mean', roleBody: 'Your role decide pages wey you fit see and work wey you fit do.', yourPages: 'Your pages and wetin dem do', pagesBody: 'Na these pages your role fit use. Tap Help for any page if you forget wetin e do.', basicsTitle: 'Three things to remember', basics: ['Use menu arrow make desktop menu small or big.', 'You fit change language anytime; the system go save your choice.', 'Tap Help for any page to see simple explanation.'], readyTitle: 'You don ready', readyBody: 'Start from the first page for your role. Read before you save, and ask supervisor if wetin happen for farm no match screen.',     help: 'Help', pageHelp: 'About this page', pageHelpBody: 'See wetin this page do and safe way to use am.', pageRoleLead: (roleTitle) => `As ${roleTitle}, follow the steps below for this page.`, fullGuide: 'Show full guide', start: 'Start guide', next: 'Next', back: 'Back', finish: 'Start to use Trovara OS', skip: 'Skip for now', close: 'Close', step: (current, total) => `Step ${current} of ${total}`,
    roles: {
      owner: { title: 'Admin', summary: 'You dey look the whole farm system and control access, setup, approval, record and business report.', duties: ['Set up users and farm places.', 'Check warning and approval.', 'Protect permission, money and audit record.'] },
      supervisor: { title: 'Supervisor', summary: 'You arrange daily farm work and check say field record match wetin really happen.', duties: ['Give and check work.', 'Check crop, animal, stock and field report.', 'Report loss, risk and strange difference.'] },
      field_worker: { title: 'Field worker', summary: 'You go clock in, finish assigned field work, report wetin you see and send proof for supervisor to check.', duties: ['Start every day for Today and clock in.', 'Finish one assigned task at a time with clear proof.', 'Report problem, pest, loss or danger as soon as you see am.'] },
      sales: { title: 'Sales', summary: 'You manage customers, orders, complaints and payments without changing physical farm stock.', duties: ['Record order and customer details well.', 'Follow complaint until dem solve am.', 'Never adjust inventory quantity.'] },
    },
    pages: pcmPages,
    rolePages: pcmRolePages,
    fallbackPage: { summary: 'This page get one special Trovara OS work for your role.', actions: ['Read heading and instruction.', 'Ask supervisor before you save wetin you no understand.'] },
  },
  yo: {
    welcome: (name) => `Káàbọ̀, ${name}`,
    welcomeBody: 'Trovara OS yóò tọ́ ọ sọ́nà. Kò pọn dandan kí o mọ ètò náà kí o tó bẹ̀rẹ̀.',
    languagePrompt: 'Yan èdè tí o lóye jù. Ìtọ́sọ́nà àti OS yóò máa lo èdè náà.',
    assignedRole: 'Ipa tí a yàn fún ọ', roleHeading: 'Ohun tí ipa rẹ túmọ̀ sí', roleBody: 'Ipa rẹ ló pinnu ojú-ewé tí o lè rí àti iṣẹ́ tí o lè ṣe.', yourPages: 'Àwọn ojú-ewé rẹ àti iṣẹ́ wọn', pagesBody: 'Àwọn ojú-ewé wọ̀nyí ni ipa rẹ lè lò. Tẹ Ìrànlọ́wọ́ lórí ojú-ewé kankan bí o bá gbàgbé iṣẹ́ rẹ̀.', basicsTitle: 'Ohun mẹ́ta láti rántí', basics: ['Lo ọfà àkójọ láti dín tàbí fa àkójọ kọ̀ǹpútà.', 'O lè yí èdè padà nígbàkigbà; a ó fi yíyan rẹ pamọ́.', 'Tẹ Ìrànlọ́wọ́ lórí ojú-ewé kankan fún àlàyé tó rọrùn.'], readyTitle: 'O ti ṣetán', readyBody: 'Bẹ̀rẹ̀ ní ojú-ewé àkọ́kọ́ fún ipa rẹ. Ka ohun gbogbo kí o tó fi pamọ́, kí o sì béèrè lọ́wọ́ supervisor bí ohun tó ṣẹlẹ̀ ní oko kò bá ohun tó wà lójú ìbòjú mu.',     help: 'Ìrànlọ́wọ́', pageHelp: 'Nípa ojú-ewé yìí', pageHelpBody: 'Ohun tí ojú-ewé yìí ń ṣe àti ọ̀nà ààbò láti lò ó.', pageRoleLead: (roleTitle) => `Gẹ́gẹ́ bí ${roleTitle}, tẹ̀lé àwọn ìgbésẹ̀ ní ìsàlẹ̀ fún ojú-ewé yìí.`, fullGuide: 'Fi gbogbo ìtọ́sọ́nà hàn', start: 'Bẹ̀rẹ̀ ìtọ́sọ́nà', next: 'Tẹ̀síwájú', back: 'Padà', finish: 'Bẹ̀rẹ̀ lílo Trovara OS', skip: 'Fò ó fún báyìí', close: 'Pa á', step: (current, total) => `Ìgbésẹ̀ ${current} nínú ${total}`,
    roles: {
      owner: { title: 'Olùṣàkóso', summary: 'Ìwọ ń bojú tó gbogbo ètò oko, àṣẹ, ìṣètò, ìfọwọ́sí, àkọsílẹ̀ àti ìròyìn.', duties: ['Ṣètò àwọn olumulo àti ibi oko.', 'Ṣàyẹ̀wò ìkìlọ̀ àti ìfọwọ́sí.', 'Dáàbò bo àṣẹ, owó àti ìtàn àyẹ̀wò.'] },
      supervisor: { title: 'Alábòójútó', summary: 'Ìwọ ń ṣètò iṣẹ́ ojoojúmọ́, o sì ń jẹ́rìí pé àkọsílẹ̀ bá ohun tó ṣẹlẹ̀ ní oko mu.', duties: ['Yan àti ṣàyẹ̀wò iṣẹ́.', 'Ṣàyẹ̀wò irugbin, ẹranko, stock àti ìròyìn oko.', 'Jábọ̀ àdánù, ewu àti ìyàtọ̀ àjèjì.'] },
      field_worker: { title: 'Òṣìṣẹ́ oko', summary: 'Ìwọ yóò wọlé sí iṣẹ́, parí iṣẹ́ oko tí a yàn, jábọ̀ ohun tí o rí, kí o sì fi ẹ̀rí ránṣẹ́ fún supervisor.', duties: ['Bẹ̀rẹ̀ ọjọ́ lórí Òní kí o sì wọlé sí iṣẹ́.', 'Parí iṣẹ́ kan lẹ́ẹ̀kan pẹ̀lú ẹ̀rí kedere.', 'Jábọ̀ ìṣòro, kòkòrò, àdánù tàbí ewu ní kíákíá.'] },
      sales: { title: 'Títà', summary: 'Ìwọ ń ṣàkóso oníbàárà, ọ̀dà, ẹ̀dùn àti ìsanwó láìyí stock gidi oko padà.', duties: ['Kọ ọ̀dà àti alaye oníbàárà dáadáa.', 'Tọ́pa ẹ̀dùn títí yóò fi parí.', 'Má ṣe yí iye inventory padà.'] },
    },
    pages: yoPages,
    rolePages: yoRolePages,
    fallbackPage: { summary: 'Ojú-ewé yìí ní iṣẹ́ Trovara OS kan fún ipa rẹ.', actions: ['Ka àkọlé àti ìtọ́sọ́nà.', 'Béèrè lọ́wọ́ supervisor kí o tó fi ohun tí o kò lóye pamọ́.'] },
  },
  fr: {
    welcome: (name) => `Bienvenue, ${name}`,
    welcomeBody: 'Trovara OS vous guidera. Vous n’avez pas besoin de connaître le système avant de commencer.',
    languagePrompt: 'Choisissez la langue que vous comprenez le mieux. Le guide et l’application la suivront.',
    assignedRole: 'Votre rôle attribué', roleHeading: 'Ce que signifie votre rôle', roleBody: 'Votre rôle détermine les pages visibles et les actions autorisées.', yourPages: 'Vos pages expliquées', pagesBody: 'Voici les pages disponibles pour votre rôle. Ouvrez Aide sur n’importe quelle page si vous oubliez sa fonction.', basicsTitle: 'Trois choses à retenir', basics: ['Utilisez la flèche du menu pour réduire ou agrandir le menu sur ordinateur.', 'Changez de langue à tout moment; votre choix est enregistré.', 'Touchez Aide sur une page pour obtenir une explication simple.'], readyTitle: 'Vous êtes prêt', readyBody: 'Commencez par la page d’accueil de votre rôle. Lisez avant d’enregistrer et demandez au superviseur si la réalité du terrain ne correspond pas à l’écran.',     help: 'Aide', pageHelp: 'À propos de cette page', pageHelpBody: 'Voici la fonction de cette page et la manière la plus sûre de l’utiliser.', pageRoleLead: (roleTitle) => `En tant que ${roleTitle}, suivez les étapes ci-dessous pour cette page.`, fullGuide: 'Voir le guide complet', start: 'Commencer le guide', next: 'Suivant', back: 'Retour', finish: 'Commencer avec Trovara OS', skip: 'Passer pour le moment', close: 'Fermer', step: (current, total) => `Étape ${current} sur ${total}`,
    roles: {
      owner: { title: 'Administrateur', summary: 'Vous supervisez tout le système et contrôlez les accès, réglages, approbations, dossiers et rapports.', duties: ['Configurer les utilisateurs et la ferme.', 'Examiner alertes et approbations.', 'Protéger les droits, les finances et l’audit.'] },
      supervisor: { title: 'Superviseur', summary: 'Vous coordonnez le travail quotidien et vérifiez que les données correspondent au terrain.', duties: ['Assigner et contrôler le travail.', 'Vérifier cultures, animaux, stock et rapports.', 'Signaler pertes, risques et écarts inhabituels.'] },
      field_worker: { title: 'Ouvrier agricole', summary: 'Vous pointez, terminez les tâches de terrain assignées, signalez vos observations et envoyez des preuves au superviseur.', duties: ['Commencez chaque jour sur Aujourd’hui et pointez.', 'Terminez une tâche assignée à la fois avec une preuve claire.', 'Signalez tout de suite problèmes, ravageurs, pertes ou dangers.'] },
      sales: { title: 'Ventes', summary: 'Vous gérez clients, commandes, réclamations et paiements sans modifier le stock physique.', duties: ['Saisir correctement commandes et clients.', 'Suivre les réclamations jusqu’à résolution.', 'Ne jamais ajuster les quantités du stock.'] },
    },
    pages: frPages,
    rolePages: frRolePages,
    fallbackPage: { summary: 'Cette page contient une fonction Trovara OS disponible pour votre rôle.', actions: ['Lisez le titre et les instructions.', 'Demandez au superviseur avant d’enregistrer ce que vous ne comprenez pas.'] },
  },
}

export function onboardingCopy(locale: string): OnboardingCopy {
  return copies[(locale in copies ? locale : 'en') as AppLocale]
}

export function pageGuide(copy: OnboardingCopy, path: string, role: UserRole): PageGuide {
  return copy.rolePages[role]?.[path] ?? copy.pages[path] ?? copy.fallbackPage
}
