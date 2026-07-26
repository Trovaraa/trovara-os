/**
 * fr exception messages. Keys mirror ./en.ts; anything absent here falls back
 * to English via the i18n fallbackLocale.
 */
export default {
  msg: {
    overdueSince: 'En retard depuis le {since}',
    overdueSinceUnknown: 'Toujours en cours, aucune échéance enregistrée',
    lowStock: '{quantity} {unit} restants (réappro. à {reorderLevel} {unit})',
    awaitingApproval: 'En attente d’approbation depuis plus de 12 h ({assignee})',
    mortality: '{count} mort(s)',
    mortalityWithNotes: '{count} mort(s) : {notes}',
    orderPending: 'En attente depuis plus de 48 h - {currency} {amount}',
    rejectedResubmit: 'Rejeté - à renvoyer ({assignee})',
    noDailyLog: 'Aucun journal quotidien enregistré aujourd’hui',
    reportedNeedsVerification: 'Signalé par {reporter} - à vérifier',
    noCensus: 'Aucun recensement des cultures vérifié pour ce bloc',
    censusRejected: 'Recensement rejeté - à renvoyer',
    censusRejectedWithReason: 'Recensement rejeté : {reason}',
    censusStale: 'Recensement vérifié il y a plus de {days} jours (dernier {lastVerified})',
  },
  title: {
    batchMortality: 'Mortalité {batch}',
    order: 'Commande : {customer}',
    censusSurvey: '{plot} · {crop}',
    assetLog: 'Journal d’équipement',
  },
  action: {
    approve: 'Approuver : {title}',
    restock: 'Réapprovisionner : {title}',
    confirmOrder: 'Confirmer la commande : {title}',
    resubmit: 'Renvoyer : {title}',
    reviewOverdue: 'Examiner la tâche en retard : {title}',
    reviewMortality: 'Examiner la mortalité : {title}',
    logEquipment: 'Enregistrer l’équipement : {title}',
    verifyAssetLog: 'Vérifier le journal d’équipement : {title}',
    recordCensus: 'Enregistrer le recensement : {title}',
    resubmitCensus: 'Renvoyer le recensement : {title}',
    refreshStaleCensus: 'Actualiser le recensement obsolète : {title}',
    weather: 'Météo : {title}',
  },
  unassigned: 'non attribué',
  staff: 'personnel',
  block: 'Bloc',
} as const
