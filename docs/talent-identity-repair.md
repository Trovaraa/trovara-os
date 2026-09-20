# Forwarded applicant identity repair

## Cause and fix

The original importer used the outer email sender as the applicant and reused a candidate by email. Forwarding several applicants from one internal mailbox therefore linked unrelated applications. Contact edits updated that shared candidate.

- Resolve a single explicit original From/To/Date/Subject header block as an unverified suggestion. Never use a Trovara forwarding mailbox as an applicant. Ambiguous/nested forwarding stays unassigned for review.
- Forwarded imports do not attach by message references or automatically reuse a candidate. If the suggested email already belongs to another profile, keep it in the preserved received event, leaving the new candidate email blank until reviewed.
- Contact changes apply to the selected application by default. A shared profile is split when corrected contact details are saved. Reusing its email requires a different/blank email for an independent person, or explicit shared-edit confirmation for the same person.
- “Separate this applicant” clears potentially contaminated contact fields into an unsaved form. Original documents remain available; nothing is submitted automatically.
- Candidate linking remains explicit; selecting an existing candidate does not overwrite that candidate. Saves are serialized with intake and reject a stale candidate ID.

## Repair utility

`scripts/repair-talent-forwarded-identities.mjs` runs with Node 22, an explicit private environment, and a built API. Default mode is read-only. Supply an anchor application UUID, expected cohort size, and a snapshot path inside a 0700 directory. Snapshots are created exclusively with mode 0600; never put them in Git or publish their contents.

The utility requires exactly one preserved original email per affected application, originally forwarded by info@trovara.farm, and an unambiguous original identity. It refuses mismatched existing identities, unexpected/deleted cohort members and repeated original identities. An optional owner-confirmed anchor name can preserve an already corrected name.

Apply requires the dry-run fingerprint. Inside one database transaction it takes the farm intake lock, re-reads and compares the snapshot, changes only candidate association and application updated_at, and appends repair/audit events. It verifies every original document, event and remaining application field is unchanged before committing. Existing matching candidates are reused without modifying their profiles. The original unlinked candidate is retained for recovery, not deleted by this utility.

Before production use: obtain owner approval, create and verify an encrypted database/evidence backup, copy it off-server, review the bounded dry-run plan, and ensure ingestion uses the fixed code. Preserve stages, assignment, deadlines, notes, correspondence, IDs, documents and intake deduplication keys. Protect snapshots as private applicant data. A repeated apply fails closed.

## Release boundaries

This branch starts from main and includes the previously deployed, unmerged Talent feature as a prerequisite while preserving main's dependency/security updates. Production can receive the identity patch as a scoped overlay on the existing Talent release without overwriting unrelated server changes; record its base release and patch commit separately rather than claiming the whole main-based release was deployed. Keep the previous worker image and encrypted source/frontend recovery archive until verification succeeds. No schema migration is required for the identity fix itself.

## Regression coverage

Unit tests cover Zoho/Gmail/Outlook forwarding, internal mailboxes, direct applicants, signatures and ambiguous/multiple senders. Database integration tests cover independent forwarded profiles, idempotent re-import, stage-only edits, independent contact corrections, explicit shared edits, stale identity rejection, tenant access boundaries and the exact eight-record repair utility including dry-run/no-write and repeated-apply rejection. UI tests verify separation clears untrusted shared contact fields without saving.
