import '../lib/env.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { processNextTalentDocument, purgeExpiredTalent } from '../lib/talent.js'
import { sendNextTalentReceipt, syncTalentZoho } from '../lib/talent-zoho.js'

// Run as a supervised, resource-limited service. No applicant content is written to logs.
async function tick() {
  const farmId = process.env.TALENT_FARM_ID?.trim()
  if (!farmId || !/^[a-f0-9-]{36}$/i.test(farmId)) throw new Error('Explicit TALENT_FARM_ID is required for this worker')
  let failures = 0
  if (process.argv.includes('--extract-one')) {
    process.exit(await processNextTalentDocument(farmId) ? 0 : 2)
  }
  if (process.env.TALENT_ZOHO_ENABLED === 'true' && farmId) {
    try {
      const result = await syncTalentZoho(farmId)
      console.log('[talent] Zoho intake', result)
      if (result.failed) failures++
    } catch { failures++; console.error('[talent] Zoho sync unavailable; continuing extraction and retention.') }
  }
  // Parse untrusted documents in disposable, memory/time-bounded processes, never the HTTP server.
  for (let i = 0; i < 10; i++) {
    try {
      await promisify(execFile)(process.execPath, [...process.execArgv, '--max-old-space-size=512', fileURLToPath(import.meta.url), '--extract-one'],
        { timeout: 180_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' })
    } catch (error) {
      if ((error as { code?: number }).code === 2) break
      failures++
      console.error('[talent] Extraction process stopped; its lease will require review. Continuing other work.')
      break
    }
  }
  if (farmId) for (let i = 0; i < 10; i++) {
    try { if (!await sendNextTalentReceipt(farmId)) break }
    catch { failures++; console.error('[talent] Receipt could not be confirmed; check Zoho Sent.'); break }
  }
  if (process.env.TALENT_RETENTION_ENABLED === 'true') {
    try { console.log('[talent] Expired applications removed:', await purgeExpiredTalent(farmId)) }
    catch { failures++; console.error('[talent] Retention failed; retry required.') }
  }
  if (failures) throw new Error('One or more worker tasks failed')
}

tick().then(() => process.exit(0)).catch(() => {
  console.error('[talent] Worker failed. Check database, Zoho, ClamAV, private storage and OCR configuration. No applicant details logged.')
  process.exit(1)
})
