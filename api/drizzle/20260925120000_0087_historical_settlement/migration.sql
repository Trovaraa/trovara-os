-- No historical invoices are automatically settled. An authorised user must explicitly confirm them.
ALTER TABLE expense_payments ADD COLUMN kind text NOT NULL DEFAULT 'payment',
  ALTER COLUMN paid_on DROP NOT NULL, ALTER COLUMN reference DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE expense_payments ADD CONSTRAINT expense_payments_kind_check CHECK (
  (kind = 'payment' AND paid_on IS NOT NULL AND reference IS NOT NULL) OR
  (kind = 'historical_settlement' AND paid_on IS NULL AND reference IS NULL)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_expense_payment_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.amount_paid > 0 AND
    (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.approval_status <> 'approved' OR NEW.farm_id <> OLD.farm_id OR NEW.entity_code <> OLD.entity_code) THEN
    RAISE EXCEPTION 'Paid invoices cannot change amount, currency, entity or approval' USING ERRCODE = '23514';
  END IF;
  IF NEW.amount_paid < 0 OR NEW.amount_paid > NEW.amount OR
     (NEW.amount_paid > 0 AND NEW.approval_status <> 'approved') THEN
    RAISE EXCEPTION 'Invalid invoice payment state' USING ERRCODE = '23514';
  END IF;
  -- Only an explicit, immutable historical settlement may close an old invoice without inventing terms.
  IF NEW.amount_paid > 0 AND NEW.payment_due_date IS NULL AND NOT (
    NEW.amount_paid = NEW.amount AND EXISTS (
      SELECT 1 FROM expense_payments WHERE expense_id = NEW.id AND farm_id = NEW.farm_id AND kind = 'historical_settlement'
    )
  ) THEN
    RAISE EXCEPTION 'Invalid invoice payment state' USING ERRCODE = '23514';
  END IF;
  IF NEW.approval_status = 'approved' AND
     (TG_OP = 'INSERT' OR OLD.approval_status IS DISTINCT FROM 'approved') THEN
    NEW.approved_at := now();
    NEW.payment_due_date := COALESCE(NEW.payment_due_date, (now() AT TIME ZONE 'UTC')::date + 7);
  END IF;
  IF NEW.approval_status <> 'approved' THEN NEW.approved_at := NULL; END IF;
  IF NEW.approved_at IS NOT NULL AND NEW.approval_status = 'approved' AND NEW.payment_due_date IS NULL THEN
    RAISE EXCEPTION 'Approved invoices require a due date' USING ERRCODE = '23514';
  END IF;
  NEW.payment_status := CASE WHEN NEW.amount_paid = 0 THEN 'unpaid'
    WHEN NEW.amount_paid < NEW.amount THEN 'partially_paid' ELSE 'paid' END;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION apply_expense_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invoice expenses%ROWTYPE;
BEGIN
  SELECT * INTO invoice FROM expenses WHERE id = NEW.expense_id AND farm_id = NEW.farm_id FOR UPDATE;
  IF NOT FOUND OR invoice.approval_status <> 'approved'
     OR (NEW.kind = 'payment' AND invoice.payment_due_date IS NULL)
     OR invoice.currency <> NEW.currency OR NEW.amount > invoice.amount - invoice.amount_paid
     OR (NEW.kind = 'historical_settlement' AND NEW.amount <> invoice.amount - invoice.amount_paid) THEN
    RAISE EXCEPTION 'Invoice is not eligible for this payment' USING ERRCODE = '23514';
  END IF;
  UPDATE expenses SET amount_paid = amount_paid + NEW.amount WHERE id = invoice.id;
  RETURN NEW;
END $$;
