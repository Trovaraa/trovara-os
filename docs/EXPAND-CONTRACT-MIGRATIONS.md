# Expand-contract database changes

Production migrations are forward-only and must preserve compatibility while
the old process and new process may overlap during a restart.

## Required sequence

1. **Expand:** add nullable columns, new tables, indexes, or permissive
   constraints. Do not rename/drop a field that the current release reads.
2. Deploy code that can read both shapes and writes the new shape. Keep this
   release rollback-compatible.
3. Backfill in bounded, restartable batches. Record progress and avoid one long
   transaction or table-wide lock.
4. Verify old and new row counts, null counts, constraints, query plans, backup
   freshness, and an isolated restore.
5. Deploy code that reads only the new shape.
6. **Contract in a later release:** remove old columns/tables, tighten
   nullability, or remove compatibility code only after the rollback window.

## Prohibited in an expand release

- destructive rename/drop or type rewrite of a live column;
- adding a non-null column without a safe default/backfill sequence;
- changing enum meaning in place;
- assuming application deploy and migration are atomic;
- editing `drizzle.__drizzle_migrations` manually.

Every pull request with a migration must state the expand step, backfill,
verification query, rollback behavior, and the future contract step. CI upgrades
a fixture one migration behind through the current tip; it supplements rather
than replaces a production-data rehearsal for high-risk changes.
