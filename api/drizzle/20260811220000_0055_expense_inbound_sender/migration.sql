-- Inbound invoice sender identity + approval acknowledgment tracking.
-- receipt_ref remains the RFC822 Message-ID for audit/threading (not the sender).

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS inbound_sender_email text,
  ADD COLUMN IF NOT EXISTS inbound_sender_name text,
  ADD COLUMN IF NOT EXISTS inbound_ack_sent_at timestamptz;

ALTER TABLE expenses
  DROP CONSTRAINT IF EXISTS expenses_inbound_sender_email_check;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_inbound_sender_email_check
  CHECK (
    inbound_sender_email IS NULL
    OR inbound_sender_email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'
  );
