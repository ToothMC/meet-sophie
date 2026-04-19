-- Billing Idempotency: prevent double-grant when both /api/billing?action=confirm
-- AND the Stripe webhook race on the same checkout.session.completed.
--
-- Previous behavior: confirm and webhook each had their own idempotency anchor
-- (analytics_events "checkout_confirmed" vs "stripe_webhook_checkout.session.completed"),
-- so a user refreshing /success while the webhook arrived in parallel could get
-- paid_tokens + topup granted twice.
--
-- This table is the single point of truth for "has this Stripe checkout session
-- already been applied to user_usage?". Both code paths INSERT ... ON CONFLICT
-- DO NOTHING before touching user_usage; only the winner writes.

CREATE TABLE IF NOT EXISTS billing_processed_sessions (
  stripe_session_id text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now(),
  processed_by text NOT NULL CHECK (processed_by IN ('confirm','webhook')),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  mode text
);

CREATE INDEX IF NOT EXISTS idx_billing_processed_sessions_user_id
  ON billing_processed_sessions(user_id);

-- Service role only — never exposed to end users.
ALTER TABLE billing_processed_sessions ENABLE ROW LEVEL SECURITY;
