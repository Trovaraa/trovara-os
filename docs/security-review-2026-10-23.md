# Security review — 23 October 2026

## Scope and remediation

Reviewed open Dependabot PRs and GitHub dependency/code-scanning alerts, regenerated patched dependency resolutions, and tested the resulting application. Consolidates the current compatible npm and pinned GitHub Actions updates without disabling audit gates.

Node2Shell (CVE-2026-111497) affects Node's Brotli decoder, including automatic decompression of fetched responses. An npm audit alone cannot establish runtime safety. Following the owner's approved major-version migration, builds are pinned to Node 24.22.1 and package engines require >=24.22.1 <25. This supersedes the initial Node 22.23.4 security rollout. Official advisory: https://nodejs.org/en/blog/vulnerability/october-2026-security-releases

Vite resolves to 6.4.5; regression tests check every locked copy. Parser fixes and earlier security overrides are retained. Full dependency audits report zero known findings at review time; this is not a guarantee against unknown vulnerabilities or a host malware assessment.

## Runtime rollout

OS: upgrade the actual systemd API executable and both worker images to Node 24.22.1, not only the build machine. Startup guards reject other major versions and unpatched Node 24 releases. Preserve environment, OCR tooling, service permissions, database and object storage; take verified encrypted recovery backups before rollout. Do not run migrations for this change. A rollback must pair the prior release with its tested patched Node 22.23.4 runtime; never run the new Node24-only release on Node22.

Marketing: Netlify controls the deployed Functions patch version independently of the build pin. Read-only function smoke checks require X-Trovara-Runtime-Secure=true. Form forwarding fails closed on unpatched runtimes. Verify a preview before production; if Netlify has not patched the supported runtime, stop and escalate to the provider rather than bypass the guard.

Shop: production is a static frontend served by nginx; Node is used to build it. Its shared OS backend must also receive the OS runtime patch.

No live exploit payloads, mailbox reads, financial edits, or email sends are required for verification. Default-branch GitHub alerts remain until these branches are merged and rescanned; deployment alone does not close them.
