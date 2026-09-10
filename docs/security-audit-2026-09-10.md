# Trovara surface audit — 2026-09-10

Scope: `trovara.farm`, `os.trovara.farm`, and `shop.trovara.farm`, plus the
`trovera`, `trovara-os`, and `trovara-shop` repositories. The requested host
`shop.trovara.far` does not resolve; it appears to be a typo for
`shop.trovara.farm`.

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

## Deployment action required

**Medium — shop response headers are incomplete in production.** On the live
shop, the HTTP response has HSTS, frame, MIME-sniffing, and referrer headers,
but it does not contain the Content-Security-Policy or Permissions-Policy that
the checked-in nginx template specifies. This makes an XSS defect materially
more damaging and permits browser capabilities by default. Reinstall/reload
the nginx configuration from
`trovara-shop/docs/nginx-shop.trovara.farm.conf.example`, then verify with:

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
- No API keys or local `.env` files are tracked by the three repositories.
- The live hosts use HTTPS and HSTS. `shop.trovara.far` returned DNS
  `ERR_NAME_NOT_RESOLVED`.
