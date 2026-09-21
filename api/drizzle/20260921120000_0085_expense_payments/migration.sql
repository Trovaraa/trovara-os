-- Existing records remain unpaid/unreviewed: approval does not prove settlement.
ALTER TABLE expenses ADD COLUMN approved_at timestamptz,
  ADD COLUMN payment_due_date date,
  ADD COLUMN amount_paid integer NOT NULL DEFAULT 0,
  ADD COLUMN payment_status text NOT NULL DEFAULT 'unpaid';
--> statement-breakpoint
CREATE TABLE expense_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL REFERENCES farms(id),
  expense_id uuid NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  paid_on date NOT NULL,
  reference text NOT NULL,
  request_id uuid NOT NULL,
  recorded_by_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (farm_id, expense_id) REFERENCES expenses(farm_id, id) ON DELETE RESTRICT,
  UNIQUE (farm_id, request_id)
);
--> statement-breakpoint
CREATE FUNCTION guard_expense_payment_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.amount_paid > 0 AND
    (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.approval_status <> 'approved' OR NEW.farm_id <> OLD.farm_id OR NEW.entity_code <> OLD.entity_code) THEN
    RAISE EXCEPTION 'Paid invoices cannot change amount, currency, entity or approval' USING ERRCODE = '23514';
  END IF;
  IF NEW.amount_paid < 0 OR NEW.amount_paid > NEW.amount OR
     (NEW.amount_paid > 0 AND (NEW.approval_status <> 'approved' OR NEW.payment_due_date IS NULL)) THEN
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
CREATE TRIGGER expense_payment_state BEFORE INSERT OR UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION guard_expense_payment_state();
--> statement-breakpoint
CREATE FUNCTION apply_expense_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invoice expenses%ROWTYPE;
BEGIN
  SELECT * INTO invoice FROM expenses WHERE id = NEW.expense_id AND farm_id = NEW.farm_id FOR UPDATE;
  IF NOT FOUND OR invoice.approval_status <> 'approved' OR invoice.payment_due_date IS NULL
     OR invoice.currency <> NEW.currency OR NEW.amount > invoice.amount - invoice.amount_paid THEN
    RAISE EXCEPTION 'Invoice is not eligible for this payment' USING ERRCODE = '23514';
  END IF;
  UPDATE expenses SET amount_paid = amount_paid + NEW.amount WHERE id = invoice.id;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER expense_payment_insert AFTER INSERT ON expense_payments
  FOR EACH ROW EXECUTE FUNCTION apply_expense_payment();
--> statement-breakpoint
CREATE FUNCTION immutable_expense_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Payment records are append-only' USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER expense_payment_immutable BEFORE UPDATE OR DELETE ON expense_payments
  FOR EACH ROW EXECUTE FUNCTION immutable_expense_payment();
