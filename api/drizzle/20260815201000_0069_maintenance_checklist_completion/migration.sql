-- Record the exact maintenance checklist items confirmed at completion.

ALTER TABLE maintenance_work_orders
  ADD COLUMN IF NOT EXISTS completed_checklist jsonb NOT NULL DEFAULT '[]'::jsonb;
