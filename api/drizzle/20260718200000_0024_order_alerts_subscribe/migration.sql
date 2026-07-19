-- Admin (owner) opt-in for customer order alerts (Telegram / WhatsApp).
-- Supervisor and sales always receive order alerts; field workers never do.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "order_alerts_subscribed" boolean DEFAULT false NOT NULL;
