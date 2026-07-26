-- Generation already computes why it produced nothing ('llm_unavailable',
-- 'budget_exhausted', 'llm_failed', 'invalid_payload', 'write_failed') and then
-- throws it away, so a farm opening a batch or a crop cycle sees an empty
-- calendar with no way to tell "the assistant is off" from "it broke, retry".
-- Persisting the reason is what lets the read path say which one it is.
--
-- Left as free text rather than an enum: it is a diagnostic string the UI maps
-- to a message, and a new reason should not need a migration to be recorded.
-- Null means no failed attempt is outstanding, which is also every existing row.
--> statement-breakpoint
ALTER TABLE "livestock_batches" ADD COLUMN IF NOT EXISTS "agronomy_skip_reason" text;
--> statement-breakpoint
ALTER TABLE "crop_cycles" ADD COLUMN IF NOT EXISTS "agronomy_skip_reason" text;
