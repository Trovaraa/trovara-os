# Trovara OS security review — 2026-09-19

Repository: Trovaraa/trovara-os. Base: f7215ca.

## Findings addressed

**Malicious DOCX/style parser denial of service:** upgrade mammoth 1.12.2 to 1.12.3. Upstream fixed pathological processing of unterminated style strings containing many escapes. This reduces a parsing DoS risk; it does not make all untrusted documents safe. Retain isolation, resource limits and timeouts for untrusted document processing. See the [upstream release notes](https://raw.githubusercontent.com/mwilliamson/mammoth.js/1.12.3/NEWS).

## Shared security hardening

- Verify the Gitleaks Linux release archive against a pinned official SHA-256 before extracting or executing it.
- Remove whole-directory secret-scan exclusions for documentation, tests and source. Keep only exact non-secret identifiers (and, in OS, a path-bound deterministic test fixture).
- Add executable scanner regression tests with disposable random canaries in formerly excluded paths.
- Update SHA-pinned CodeQL to 4.38.0 and OSV Scanner Action to 2.6.0. OSV 2.6.0 includes fail-closed behavior for incomplete scans; see its [release notes](https://github.com/google/osv-scanner-action/releases/tag/v2.6.0).

## Scan evidence and limits

GitHub reported **zero open Dependabot vulnerability alerts and zero open code-scanning alerts** for each of Trovaraa/trovara, trovara-os and trovara-shop on 2026-09-19. Native GitHub secret scanning was disabled; the repositories do run custom Gitleaks CI.

Gitleaks 8.30.1 scanned all history reachable from origin/main with the tightened configuration: no confirmed leaked credentials. OS initially flagged non-secret advisory identifiers and a deterministic encryption fixture, now covered by narrow allowlists. Canary regression checks pass in all three repositories.

Dependencies were installed with lifecycle scripts disabled. Lockfile review found registry.npmjs.org HTTPS origins and integrity hashes, with no unexpected external origins. npm registry signature verification passed for 540 marketing, 792 OS and 292 shop packages (1,624 total), with 159, 229 and 84 provenance attestations respectively. Installed lifecycle hooks were limited to esbuild's Node installer. Signatures establish package provenance/integrity, not absence of malicious behavior.

Static indicator review found no common downloader-and-shell, encoded execution, miner, reverse-shell or TLS-disable patterns in the reviewed tracked source/configuration. This is not an exhaustive security audit or a guarantee that all malware/vulnerabilities are absent. Production hosts, container images, databases and private runtime configuration were not audited or changed.

## Change boundaries

ClamAV 1.5.3 ran in a disposable, unprivileged container with read-only mounts of the three review worktrees. Freshclam updated the daily database from 28080 to 28128 before scanning. Aggregate result: 1,042 files scanned, **zero infected files**, 3,628,071 known signatures. Dependency and build-output subdirectories were excluded; dependencies received the separate audit/signature checks above. No files were uploaded to an external malware-analysis service.

Prepared on a new branch from the latest origin/main observed at review start. No production deployment, merge, alert dismissal, original Dependabot PR closure, applicant-data access or email action is part of this change. Re-run GitHub checks before merging.

## Existing Dependabot PRs

- [#51](https://github.com/Trovaraa/trovara-os/pull/51): grouped npm update. This change includes the mammoth security patch; routine AWS, happy-dom, geoip data, jszip, resend, Node types and autoprefixer updates remain separate.
- [#52](https://github.com/Trovaraa/trovara-os/pull/52) and [#53](https://github.com/Trovaraa/trovara-os/pull/53): Drizzle prerelease upgrades, not treated as security fixes.
- [#54](https://github.com/Trovaraa/trovara-os/pull/54): CodeQL/OSV scanner updates, included here.

## Validation

- 2,072 API tests and 117 app tests passed with maxWorkers=2 and a dummy local test DATABASE_URL; no production credentials used.
- Release-tool tests and 2 scanner safeguard tests passed.
- Lint, typecheck, API build and app build passed.
- npm audit: zero known vulnerabilities after update.
- An initial unrestricted parallel test run hit two AI-route timing failures; the complete bounded-worker rerun passed. No test or timeout assertions were weakened.
- Database migration integration is left to the repository's PostgreSQL CI workflow; no schema changes were made.

## Deployment warning

The deployed Talent release is on unmerged feat/talent-management-20260913 (9d4d0d4), not main. Reconcile that feature before a later production deployment; deploying this main-based branch alone could remove Talent. This PR does not change the live server or its intake configuration.
