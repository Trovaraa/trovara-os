-- Keep contractor payments within the approved engagement value at the database layer.

ALTER TABLE contractor_engagements
  DROP CONSTRAINT IF EXISTS contractor_engagements_amounts_check;
ALTER TABLE contractor_engagements
  ADD CONSTRAINT contractor_engagements_amounts_check
  CHECK (agreed_amount_minor >= 0 AND paid_amount_minor >= 0 AND paid_amount_minor <= agreed_amount_minor);
