/**
 * yo exception messages. Keys mirror ./en.ts; anything absent here falls back
 * to English via the i18n fallbackLocale.
 */
export default {
  msg: {
    overdueSince: 'Ó ti kọjá àkókò láti {since}',
    overdueSinceUnknown: 'Kò tíì parí, kò sí ọjọ́ ìparí tí a kọ sílẹ̀',
    lowStock: '{quantity} {unit} ló kù (tún paṣẹ ní {reorderLevel} {unit})',
    awaitingApproval: 'Ń dúró fún ìfọwọ́sí ju wákàtí 12 lọ ({assignee})',
    mortality: '{count} ló kú',
    mortalityWithNotes: '{count} ló kú: {notes}',
    orderPending: 'Ó ń dúró ju wákàtí 48 lọ - {currency} {amount}',
    rejectedResubmit: 'Wọ́n kọ̀ ọ́ - tún fi ránṣẹ́ ({assignee})',
    noDailyLog: 'Kò sí àkọsílẹ̀ ojoojúmọ́ lónìí',
    reportedNeedsVerification: '{reporter} ló ròyìn rẹ̀ - ó nílò ìjẹ́rìí',
    noCensus: 'Kò sí ìṣirò irúgbìn tí a jẹ́rìí fún block yìí',
    censusRejected: 'Wọ́n kọ ìṣirò irúgbìn - tún fi ránṣẹ́',
    censusRejectedWithReason: 'Wọ́n kọ ìṣirò irúgbìn: {reason}',
    censusStale: 'Ìṣirò tí a jẹ́rìí ti ju ọjọ́ {days} lọ (ìkẹyìn {lastVerified})',
  },
  title: {
    batchMortality: 'Ikú {batch}',
    order: 'Àṣẹ: {customer}',
    censusSurvey: '{plot} · {crop}',
    assetLog: 'Àkọsílẹ̀ ohun èlò',
  },
  action: {
    approve: 'Fọwọ́sí: {title}',
    restock: 'Tún ọjà kún: {title}',
    confirmOrder: 'Fìdí àṣẹ múlẹ̀: {title}',
    resubmit: 'Tún fi ránṣẹ́: {title}',
    reviewOverdue: 'Ṣàyẹ̀wò iṣẹ́ tó ti kọjá àkókò: {title}',
    reviewMortality: 'Ṣàyẹ̀wò ikú: {title}',
    logEquipment: 'Kọ ohun èlò sílẹ̀: {title}',
    verifyAssetLog: 'Jẹ́rìí àkọsílẹ̀ ohun èlò: {title}',
    recordCensus: 'Kọ ìṣirò irúgbìn sílẹ̀: {title}',
    resubmitCensus: 'Tún ìṣirò irúgbìn fi ránṣẹ́: {title}',
    refreshStaleCensus: 'Sọ ìṣirò tó ti pẹ́ di tuntun: {title}',
    weather: 'Ojú ọjọ́: {title}',
  },
  unassigned: 'kò yàn sí ẹnìkan',
  staff: 'òṣìṣẹ́',
  block: 'Block',
} as const
