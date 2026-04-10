-- Zero out legacy free tokens (free plan removed)
UPDATE public.user_usage
SET free_tokens_total = 0, free_tokens_used = 0
WHERE free_tokens_total > 0;
