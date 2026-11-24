# Dependency maintenance 24 November 2026

This release consolidates Dependabot PRs #89, #90, #93, #95, #96 and #97 against main `766a33362f083a14f48c32cf6750fe174fe2cb4b`. The previous deployed release history is retained through a merge whose tree equals main after the PR #80 squash.

## Changes

- Retain the 23 reviewed npm updates from #97. The regenerated lock resolves Hono 4.13.21 and `@hono/node-server` 2.1.11, covering the older individual fixes in #95 and #93. The direct API IP parser and its GeoIP override both use 10.7.6.
- Use Drizzle ORM and toolkit `1.0.0-rc.5` together. The Talent Zoho advisory-lock query now declares its `{ acquired: boolean }` result explicitly for the updated driver types. The SQL, locking and import behaviour are unchanged. A real PostgreSQL concurrency regression verifies that a second intake returns busy without contacting the provider.
- Align the existing Vite override with the app's 6.4.6 update. The bot branch's stale 6.4.5 override made `npm ci` fail.
- Upgrade glob to 14.0.6 for [GHSA-3g3m-2fjr-6pw4](https://github.com/isaacs/node-glob/security/advisories/GHSA-3g3m-2fjr-6pw4). Scope minimatch 11.0.9 to `@vue/language-core` and `editorconfig` for [GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249). Other modern consumers already resolve the patched major; legacy majors 3 and 5 keep their own APIs. These are real package updates, without advisory exclusions. Actual Vue typechecking, the Workbox build and EditorConfig matching verify compatibility.
- Keep the existing scoped Rollup `deepmerge` replacement and its source/behaviour regressions from `dependency-maintenance-2026-10-28.md`.
- Raise `.nvmrc`, engines, worker Docker base and the fail-closed API/worker guard to stable Node 24.22.3 or newer within major 24. The [official November security release](https://nodejs.org/en/blog/release/v24.22.3) fixes additional HTTP, HTTP/2 and TLS issues. Version 24.22.3 is the latest 24.x entry in the official distribution index checked on 24 November. The local Darwin arm64 archive SHA-256 matches the official value `ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd`.
- Apply #96's exact CodeQL 4.39.3 (`33d7b85da1a04171e211befe2c739303b9a4c066`) and OSV Scanner Action 2.7.1 (`32d3cd482bdadfb38b186c0ad1b031902d55d932`) commits. Both match their official annotated release tags. Update the scanner safeguard to the reviewed new exact pin; scanner rules, severity and coverage remain intact.

## Validation and deployment boundary

A clean script-disabled install, full API/UI suites, dependency and release-tooling regressions, lint, typechecks and API/frontend builds pass on checksum-verified Node 24.22.3. Full and production npm audits report zero findings. Registry verification passes for 786 signatures and 269 attestations.

Disposable local PostgreSQL 17 with pgvector verifies the 91-migration upgrade, historical cost-centre assignments, Finance invoice/payment preservation and 27 Finance/custom-role plus 23 Talent integration cases. No schema or migration files change. These tests create only synthetic local fixtures and contact no real mailbox or payment provider.

Production deployment must upgrade the actual API and both worker executables to Node 24.22.3 before starting this code. Preserve the currently patched worker base, OCR packages, scanner settings, environment, users, commands and resource limits. This dependency PR does not itself change production data or configuration, apply migrations, merge main or close the original bot PRs.
