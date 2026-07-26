/**
 * en exception messages, titles, and action labels.
 *
 * Mirrors the key vocabulary in api/src/lib/exception-messages.ts. Params
 * listed in DATE_PARAM_KEYS (see composables/useExceptionText) arrive as ISO
 * strings and are formatted before interpolation.
 */
export default {
  msg: {
    overdueSince: 'Overdue since {since}',
    overdueSinceUnknown: 'Still open, no due date recorded',
    lowStock: '{quantity} {unit} remaining (reorder at {reorderLevel} {unit})',
    awaitingApproval: 'Awaiting approval for over 12h ({assignee})',
    mortality: '{count} died',
    mortalityWithNotes: '{count} died: {notes}',
    orderPending: 'Pending over 48h - {currency} {amount}',
    rejectedResubmit: 'Rejected - needs resubmission ({assignee})',
    noDailyLog: 'No daily log recorded yet today',
    reportedNeedsVerification: 'Reported by {reporter} - needs verification',
    noCensus: 'No verified crop census for this block',
    censusRejected: 'Census rejected - needs resubmission',
    censusRejectedWithReason: 'Census rejected: {reason}',
    censusStale: 'Verified census older than {days} days (last {lastVerified})',
  },
  title: {
    batchMortality: '{batch} mortality',
    order: 'Order: {customer}',
    // {crop} carries free-text `crop_type` and is interpolated as typed; see
    // api/src/lib/exception-messages.ts for why there is no crop key table.
    censusSurvey: '{plot} · {crop}',
    assetLog: 'Equipment log',
  },
  action: {
    approve: 'Approve: {title}',
    restock: 'Restock: {title}',
    confirmOrder: 'Confirm order: {title}',
    resubmit: 'Resubmit: {title}',
    reviewOverdue: 'Review overdue task: {title}',
    reviewMortality: 'Review mortality: {title}',
    logEquipment: 'Log equipment: {title}',
    verifyAssetLog: 'Verify equipment log: {title}',
    recordCensus: 'Record census: {title}',
    resubmitCensus: 'Resubmit census: {title}',
    refreshStaleCensus: 'Refresh stale census: {title}',
    weather: 'Weather: {title}',
  },
  unassigned: 'unassigned',
  staff: 'staff',
  block: 'Block',
} as const
