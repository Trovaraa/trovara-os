/** Mirrors `/api/consent/status` - version and required types come from the server. */
export type ConsentStatus = {
  acceptedLatest: boolean
  currentVersion: string
  requiredTypes: Array<'privacy' | 'data_processing'>
  latest: Array<{
    consentType: 'privacy' | 'data_processing'
    version: string | null
    acceptedByCurrentUser: boolean
  }>
}
