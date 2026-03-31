-- User-defined behavioral rules that Sophie learns over time
-- Sophie writes these from chat, user can only delete/reset in settings
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS custom_rules jsonb DEFAULT '[]'::jsonb;
COMMENT ON COLUMN user_profile.custom_rules IS 'Array of {rule, context, created_at} objects. Sophie writes, user can delete.';
