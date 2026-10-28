# Dependency and PR maintenance — 2026-10-28

PR #80 now includes current main (`bbf0c99`) without reverting the deployed Brand Kit fixes, patched Zod 4.6.7, Happy DOM 21.0.4, fast-uri 3.1.9 or serialize-javascript 7.1.4. The merge conflict came from main receiving the earlier security release as a squash commit.

## Dependabot coverage

| PR | Resolution in this branch |
| --- | --- |
| #81 | Zod 4.6.7 and Happy DOM 21.0.4 retained, including the Zod migration regression tests |
| #82 | fast-uri 3.1.9 retained |
| #83 | Happy DOM 21.0.4 retained in both manifests and the override |
| #84 | Zod 4.6.7 supersedes the proposed 4.6.6 |
| #85 | serialize-javascript 7.1.4 retained |
| #86 | AWS SDK, GeoIP data, Hono, ip-address, mailparser, PDFKit types and typescript-eslint updates merged; ip-address overrides also updated to 10.7.5 |
| #87 | Pinned CodeQL v4.39.1 update merged |

## Removing the unpatched deepmerge build dependency

[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) affects deepmerge 4.2.0–4.3.1; the registry has no patched release as of this review. It enters through vite-plugin-pwa → workbox-build → @rollup/plugin-node-resolve 16.0.3. It is used by that resolver once to clone its static JSON-compatible defaults: `deepMerge({}, defaults)`.

The override is scoped to **@rollup/plugin-node-resolve@16.0.3 only** and replaces its deepmerge dependency with the published, integrity-pinned `lodash.merge@4.6.2` package. The lockfile records its real package name and registry artifact; this is not an advisory dismissal or renamed copy of vulnerable code.

This is **not a general drop-in replacement**: lodash.merge mutates its first argument and merges arrays by index, whereas deepmerge returns a new object and normally concatenates arrays. Those differences do not affect the reviewed empty-target defaults clone. Regression tests verify the installed resolver's single call, cloned arrays/nested values, frozen defaults and prototype-poisoning resistance. Full production builds exercise Workbox service-worker generation. If the resolver version or usage changes, re-review or remove this override; do not broaden it globally.

Validation: 2,242 API tests, 163 UI tests, ten dependency regression tests, release-tooling tests, lint, typecheck and production builds pass on Node 24.22.1. Full and production npm audits report zero findings; 767 registry signatures and 245 attestations verify. The first local test attempt was blocked from opening a loopback listener by the sandbox; the complete suite passed with local listener access.

This PR update does not deploy production or change financial, applicant or media records. GitHub default-branch alerts remain until the fixes are merged and rescanned.
