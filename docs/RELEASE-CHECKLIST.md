# Coordinated OS and marketing release

Release and verify the OS before marketing pages that call its public APIs.
The OS holds the live data and contracts those pages depend on.

## Checklist

1. Confirm CI API tests, OS app tests, builds, audit, and migration-upgrade job.
2. Confirm the working tree is clean and select an immutable commit or tag
   (`RELEASE_REF=<sha-or-tag>`). `deploy.sh` refuses dirty trees.
3. Confirm production environment preflight, off-server backup destination, and
   restore timer are healthy.
4. Deploy OS. Verify `/health`, `/ready`, and `/RELEASE.json`; its SHA must match
   the selected Git object.
5. Smoke-test public endpoints used by marketing (Journal, Moments, Careers,
   shop, lots, newsletter, contacts).
6. Deploy marketing only after step 5. Purge/invalidate caches if applicable.
7. Recheck both origins and record the OS SHA, tag, marketing deploy identifier,
   operator, and time in the release record.

`npm run release:coordinated -- [deploy flags]` automates the ordering. It runs
the OS deployment and verifies the embedded SHA before invoking the optional,
operator-configured `MARKETING_DEPLOY_COMMAND`. It does not edit the marketing
repository or hardcode a deployment provider.

If the OS check fails, stop. Prefer rolling the OS forward when you can; do not
deploy a marketing build that assumes an OS contract that is not live yet.
