/**
 * Retry content that was stored in the author's language because translation
 * was unavailable on write (`translationStatus: 'pending'`).
 *
 * Bounded per run and safe to re-run at any time, including alongside another
 * copy of itself.
 *
 * Usage: npm run retry-translations -w api [-- --limit=50 --farm=<uuid> --attempts=6]
 */
import '../lib/env.js'
import { runTranslationRetry } from '../lib/translation-retry.js'

function flag(name: string): string | undefined {
  const prefix = `--${name}=`
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  return match?.slice(prefix.length).trim() || undefined
}

async function main() {
  const rawLimit = flag('limit')
  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined
  if (rawLimit && (!Number.isFinite(limit) || (limit ?? 0) < 1)) {
    console.error(`--limit must be a positive integer (got "${rawLimit}")`)
    process.exit(1)
  }

  // Lets an operator drain a backlog the LLM will clearly never translate by
  // lowering the give-up threshold for one run.
  const rawAttempts = flag('attempts')
  const giveUpAttempts = rawAttempts ? Number.parseInt(rawAttempts, 10) : undefined
  if (rawAttempts && (!Number.isFinite(giveUpAttempts) || (giveUpAttempts ?? 0) < 1)) {
    console.error(`--attempts must be a positive integer (got "${rawAttempts}")`)
    process.exit(1)
  }

  const counts = await runTranslationRetry({ limit, farmId: flag('farm'), giveUpAttempts })

  console.log(
    `Translation retry: scanned ${counts.scanned}, translated ${counts.translated}, ` +
      `still pending ${counts.stillPending}, failed ${counts.failed}, ` +
      `skipped for budget ${counts.budgetSkipped}.`,
  )
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
