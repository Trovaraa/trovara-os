/** Display saved snapshots only; never relabel history with today's user role. */
export function securityEventDetails(metadata: Record<string, unknown>): string {
  const skip = new Set(['ip', 'country', 'region'])
  const keys = [...new Set(['role', 'systemRole', ...Object.keys(metadata)])]
    .filter(key => !skip.has(key) && metadata[key] !== undefined && metadata[key] !== null)
  return keys.slice(0, 6).map(key => {
    const label = key === 'systemRole' ? 'system role'
      : key === 'role' && !('systemRole' in metadata) ? 'role (legacy system)' : key
    return `${label}: ${String(metadata[key])}`
  }).join(' · ')
}
