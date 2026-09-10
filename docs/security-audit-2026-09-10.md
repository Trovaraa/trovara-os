# Trovara surface audit — 2026-09-10

Scope: `trovara.farm`, `os.trovara.farm`, and `shop.trovara.farm`, plus the
`trovera`, `trovara-os`, and `trovara-shop` repositories. The owner confirmed
`shop.trovara.farm` as the intended shop domain.

## Fixed in the repositories

- Dependency advisories were resolved by refreshing the committed lockfiles.
  This removes `fast-uri` and `js-yaml` advisories in the marketing site;
  `@xmldom/xmldom`, `fast-uri`, and Hono advisories in Farm OS; and `js-yaml`
  in the shop. Farm OS and shop also move Vitest to 4.1.11, which resolves the
  `@vitest/mocker` path-traversal advisory.
- Farm OS now fails CORS closed when `CORS_ORIGIN` is missing in production.
  Previously, an omitted configuration value permitted the local development
  origin. Set an explicit production allow-list before deployment, for example
  `CORS_ORIGIN=https://os.trovara.farm,https://shop.trovara.farm`.

## Shop header remediation

The initial live response was missing Content-Security-Policy and
Permissions-Policy despite their presence in the repository template. The
active shop nginx configuration was subsequently backed up, patched,
syntax-checked, and reloaded. Both headers were verified on the public
response. Shop deployments now check for the required header names.
To verify the current response:

```sh
curl -I https://shop.trovara.farm
```

The response should include both `content-security-policy` and
`permissions-policy`. The Farm and Farm OS hosts do serve CSP and Permissions
Policy at the time of this audit.

## UX/UI findings

- **Farm:** Clear hierarchy, meaningful calls to action, visible forecast
  disclaimers, keyboard skip link, and a non-blocking cookie choice. This is
  ready for the public journey.
- **Farm OS:** The focused, low-distraction sign-in screen is appropriate for
  staff. Improve the contrast of the small secondary links and the dark input
  boundaries; they are hard to distinguish at a glance. Consider making the
  privacy-policy link a conventional visible link rather than a small inline
  line beneath the consent text.
- **Shop:** The “not on sale yet” state is truthful and gives a useful waitlist
  path. However, two disabled hero buttons read as primary actions without
  explaining why they are unavailable. Replace them with an enabled
  “View products & waitlists” action, or add concise disabled-state help text.
  The repeated moving careers strip also competes with the purchase/account
  path; reduce its motion or frequency.

## Validation record

- `npm audit` reports zero vulnerabilities after the lockfile updates.
- The local `.env` and `.env.deploy` files checked are not tracked. This is
  not a complete historical secret scan.
- The live hosts use HTTPS and HSTS.

## Follow-up after merging the initial fixes

GitHub confirms that Farm #50, Farm OS #47, and shop #11 were merged.
On rechecking September 10, all three repositories have zero open Dependabot
alerts and zero open code-scanning alerts. The remaining Dependabot PRs are
grouped version updates, not proof of remaining vulnerability alerts.

Fresh `fix/dependabot-updates-20260910` branches were created from current
`main` in each repository to incorporate those updates. Farm OS also raises
the stale `fast-uri` override from 3.1.5 to 3.1.6 and the Hono minimum to
4.13.5, preventing later installs from undoing the security fixes. The
earlier lockfile-only update had not corrected that override.
