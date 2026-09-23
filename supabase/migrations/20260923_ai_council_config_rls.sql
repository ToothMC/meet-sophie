-- Supabase Advisor (rls_disabled_in_public, CRITICAL): ai_council_config was
-- created without RLS, so anon/authenticated could read AND write the council
-- kill switch + advisor lists via /rest/v1/ai_council_config.
--
-- All callers (api/admin.js, api/chat.js, lib/ai/council*.js) use
-- SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS. So: enable RLS with no
-- policies (deny-all for anon/authenticated, same as api_budget_alerts) and
-- drop the default table grants as defense in depth.

ALTER TABLE public.ai_council_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ai_council_config FROM anon, authenticated;
