import { logApiEvent } from './api-log.js'

export function triggerJournalBuildHook(postId: string): void {
  const hook = process.env.NETLIFY_JOURNAL_BUILD_HOOK?.trim()
  if (!hook) return

  void (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(hook, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: 'journal', postId }),
      })
      if (!response.ok) {
        logApiEvent('journal_build_hook_failed', { postId, status: response.status })
      }
    } catch {
      logApiEvent('journal_build_hook_failed', { postId, reason: 'request_failed' })
    } finally {
      clearTimeout(timeout)
    }
  })()
}
