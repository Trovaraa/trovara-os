// Node2Shell (CVE-2026-111497) is in Node, not an npm dependency.
// Keep the API and workers on the tested, patched Node 22 LTS line.
export function isSupportedSecureRuntime(version: string): boolean {
  if (!/^22\.\d+\.\d+$/.test(version)) return false
  const [, minor, patch] = version.split('.').map(Number)
  return minor > 23 || (minor === 23 && patch >= 4)
}

if (!isSupportedSecureRuntime(process.versions.node)) {
  throw new Error('Trovara OS requires patched Node.js >=22.23.4 <23 (CVE-2026-111497). Upgrade the API and worker runtimes before starting this release.')
}
