-- Provider reconciliation states and uniqueness for safe retries.
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_provider_event_uq
  ON payment_attempts (provider_event_id)
  WHERE provider_event_id IS NOT NULL;

ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempts_status_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_status_check
  CHECK (status IN (
    'initializing',
    'initiated',
    'initialization_unknown',
    'success',
    'failed',
    'abandoned'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS payment_refunds_provider_id_uq
  ON payment_refunds (provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;

ALTER TABLE payment_refunds DROP CONSTRAINT IF EXISTS payment_refunds_status_check;
ALTER TABLE payment_refunds ADD CONSTRAINT payment_refunds_status_check
  CHECK (status IN ('pending', 'submitting', 'unknown', 'success', 'failed'));
