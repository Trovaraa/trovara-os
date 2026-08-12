-- Farm toggle for the daily OS + marketing health/SLA Telegram report.
ALTER TABLE "farms"
  ADD COLUMN IF NOT EXISTS "health_sla_alerts_enabled" boolean DEFAULT true NOT NULL;
