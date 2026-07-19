-- Admin (owner) opt-in for field-worker alerts (task done, urgent reports via TG/WA).
-- Supervisors always receive these; field workers and sales do not.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "worker_alerts_subscribed" boolean DEFAULT false NOT NULL;
