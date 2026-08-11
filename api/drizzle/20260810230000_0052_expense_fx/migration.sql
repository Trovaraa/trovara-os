-- Preserve receipt currency while storing converted NGN for finance totals.

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS original_amount numeric(18, 2),
  ADD COLUMN IF NOT EXISTS original_currency text,
  ADD COLUMN IF NOT EXISTS fx_rate numeric(18, 6),
  ADD COLUMN IF NOT EXISTS fx_converted_at timestamptz;

ALTER TABLE expenses
  DROP CONSTRAINT IF EXISTS expenses_fx_metadata_check;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_fx_metadata_check
  CHECK (
    (original_amount IS NULL AND original_currency IS NULL AND fx_rate IS NULL AND fx_converted_at IS NULL)
    OR
    (
      original_amount IS NOT NULL
      AND original_amount >= 0
      AND original_currency IS NOT NULL
      AND original_currency <> 'NGN'
      AND (
        (
          fx_rate IS NULL
          AND fx_converted_at IS NULL
          AND currency = original_currency
        )
        OR
        (
          fx_rate IS NOT NULL
          AND fx_rate > 0
          AND fx_converted_at IS NOT NULL
          AND currency = 'NGN'
        )
      )
    )
  );
