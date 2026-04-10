-- Trial Pricing Model: Add trial tracking columns to user_subscriptions
-- and first_session_tracked to user_usage for analytics

-- 1) trial_end: when the Stripe trial period ends
ALTER TABLE public.user_subscriptions
  ADD COLUMN IF NOT EXISTS trial_end timestamptz;

-- 2) cancel_at_period_end: user canceled but subscription still active until period end
ALTER TABLE public.user_subscriptions
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean DEFAULT false;

-- 3) first_session_tracked: prevent duplicate first_session analytics events
ALTER TABLE public.user_usage
  ADD COLUMN IF NOT EXISTS first_session_tracked boolean DEFAULT false;

-- 4) trial_started_at: when the trial began (for day_3/day_7 analytics)
ALTER TABLE public.user_subscriptions
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz;
