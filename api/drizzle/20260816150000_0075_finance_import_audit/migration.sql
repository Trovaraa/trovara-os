ALTER TABLE expenses ADD COLUMN IF NOT EXISTS import_source_sheet text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS import_source_hash text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS import_source_record_id text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS import_source_row_hash text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS import_amount_derived boolean NOT NULL DEFAULT false;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payer text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS funding_status text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS project_phase text;

CREATE INDEX IF NOT EXISTS expenses_farm_import_source_hash_idx
  ON expenses(farm_id, import_source_hash);

-- Replace the old file-bound fingerprint with the same content fingerprint
-- used by the importer. This lets an expense already imported from v2 block
-- the same expense in v2(1), while retaining the unique farm-level guard.
WITH recalculated AS (
  SELECT id,
    encode(digest(concat_ws(chr(31),
      to_char(expense_date AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
      lower(regexp_replace(trim(description), '\s+', ' ', 'g')),
      amount::text,
      upper(trim(currency)),
      lower(regexp_replace(trim(coalesce(vendor, '')), '\s+', ' ', 'g')),
      lower(regexp_replace(trim(coalesce(receipt_ref, '')), '\s+', ' ', 'g'))
    ), 'sha256'), 'hex') AS stable_fingerprint,
    row_number() OVER (
      PARTITION BY farm_id, encode(digest(concat_ws(chr(31),
        to_char(expense_date AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
        lower(regexp_replace(trim(description), '\s+', ' ', 'g')),
        amount::text,
        upper(trim(currency)),
        lower(regexp_replace(trim(coalesce(vendor, '')), '\s+', ' ', 'g')),
        lower(regexp_replace(trim(coalesce(receipt_ref, '')), '\s+', ' ', 'g'))
      ), 'sha256'), 'hex')
      ORDER BY created_at, id
    ) AS duplicate_rank
  FROM expenses
  WHERE source = 'import' AND import_fingerprint IS NOT NULL
)
UPDATE expenses AS target
SET import_fingerprint = CASE WHEN recalculated.duplicate_rank = 1 THEN recalculated.stable_fingerprint ELSE NULL END
FROM recalculated
WHERE target.id = recalculated.id;
