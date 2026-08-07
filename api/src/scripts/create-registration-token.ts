/**
 * Mint a single-use owner-registration token directly in the DB.
 *
 * Use this for the very first Founder (no owner exists yet, so the owner-only
 * API endpoint can't be called). Prints the raw token ONCE — copy it into the
 * /register form. The token auto-invalidates after one successful registration.
 *
 * Usage:
 *   npm run reg-token -w api                       # 24h token
 *   npm run reg-token -w api -- --ttl=2 --label="initial founder"
 */
import '../lib/env.js'
import { createRegistrationToken } from '../lib/registration-tokens.js'

function parseArgs(argv: string[]): { ttlHours?: number; label?: string } {
  const out: { ttlHours?: number; label?: string } = {}
  for (const arg of argv) {
    const ttl = arg.match(/^--ttl=(\d+)$/)
    if (ttl) out.ttlHours = Number(ttl[1])
    const label = arg.match(/^--label=(.+)$/)
    if (label) out.label = label[1]
  }
  return out
}

async function main() {
  const { ttlHours, label } = parseArgs(process.argv.slice(2))
  const generated = await createRegistrationToken({
    createdByUserId: null,
    label: label ?? 'bootstrap CLI',
    ttlHours,
  })

  console.log('\nOwner registration token (copy now — shown once):\n')
  console.log(`  ${generated.token}\n`)
  console.log(`  expires: ${generated.expiresAt.toISOString()}`)
  console.log(`  label:   ${label ?? 'bootstrap CLI'}`)
  console.log('\nPaste it into the "registration secret" field at /register.')
  console.log('It becomes invalid the moment an account is created with it.\n')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed to create registration token:', err)
    process.exit(1)
  })
