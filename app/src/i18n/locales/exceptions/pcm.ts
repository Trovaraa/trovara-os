/**
 * pcm exception messages. Keys mirror ./en.ts; anything absent here falls back
 * to English via the i18n fallbackLocale.
 */
export default {
  msg: {
    overdueSince: 'Don pass time since {since}',
    overdueSinceUnknown: 'E no finish yet, no due date dey',
    lowStock: '{quantity} {unit} remain (reorder at {reorderLevel} {unit})',
    awaitingApproval: 'Dey wait approval pass 12h ({assignee})',
    mortality: '{count} don die',
    mortalityWithNotes: '{count} don die: {notes}',
    orderPending: 'Don dey wait pass 48h - {currency} {amount}',
    rejectedResubmit: 'Dem reject am - send am again ({assignee})',
    noDailyLog: 'Never log daily record today',
    maintenanceDue: 'Maintenance don due (scheduled {nextService})',
    reportedNeedsVerification: '{reporter} report am - e need verify',
    noCensus: 'No verified crop census for dis block',
    censusRejected: 'Dem reject census - send am again',
    censusRejectedWithReason: 'Dem reject census: {reason}',
    censusStale: 'Verified census don pass {days} days (last na {lastVerified})',
  },
  title: {
    batchMortality: '{batch} death',
    order: 'Order: {customer}',
    censusSurvey: '{plot} · {crop}',
    assetLog: 'Equipment log',
  },
  action: {
    approve: 'Approve am: {title}',
    restock: 'Restock: {title}',
    confirmOrder: 'Confirm order: {title}',
    resubmit: 'Send am again: {title}',
    reviewOverdue: 'Check work wey don pass time: {title}',
    reviewMortality: 'Check death: {title}',
    logEquipment: 'Log equipment: {title}',
    serviceEquipment: 'Service equipment: {title}',
    verifyAssetLog: 'Verify equipment log: {title}',
    recordCensus: 'Record census: {title}',
    resubmitCensus: 'Send census again: {title}',
    refreshStaleCensus: 'Update census wey don old: {title}',
    weather: 'Weather: {title}',
  },
  unassigned: 'nobody get am',
  staff: 'staff',
  block: 'Block',
} as const
