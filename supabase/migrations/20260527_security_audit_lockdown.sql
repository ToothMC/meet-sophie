-- Security-Audit-Sprint nach Supabase Advisor (Mai 2026):
--
-- (1) 11 Funktionen ohne SET search_path → search_path = public, pg_temp
-- (2) 5 SECURITY DEFINER Funktionen exposed via /rest/v1/rpc/ →
--     REVOKE EXECUTE FROM PUBLIC, anon, authenticated.
--     Service-Role bleibt unbeeinflusst — unsere Backend-APIs nutzen
--     SUPABASE_SERVICE_ROLE_KEY und bypassen die Permission-Checks.
-- (3) chat_sessions hat noch die alte "Anyone can insert chat sessions"-
--     Policy mit WITH CHECK(true). 20260323 wollte sie ersetzen, aber
--     Linter sieht sie noch. Wir droppen + recreaten defensiv.
--
-- Backend-Aufruferprüfung (vor Schreiben dieser Migration verifiziert):
--   - api/user.js, api/meeting.js, api/finalize-session.js, api/session.js,
--     api/ai/transcribe.js — alle nutzen createClient mit
--     SUPABASE_SERVICE_ROLE_KEY → REVOKE betrifft sie nicht.
--   - Wenn diese Funktionen jemals von Frontend mit anon-/auth-Key
--     gerufen würden (Drift!), würden sie nach dieser Migration mit
--     permission denied fehlschlagen. Das ist BEABSICHTIGT — der korrekte
--     Aufrufer ist die Backend-API, nicht der Browser.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- Part 1: search_path für bekannte Funktionen (Signaturen aus Repo)
-- ─────────────────────────────────────────────────────────────────────────

ALTER FUNCTION public.deduct_tokens(uuid, integer)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.meeting_create_with_token_gate(uuid, text, text, text, uuid, integer, text)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.meeting_billing_checkpoint(uuid, uuid, numeric)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.meeting_finalize_billing(uuid, uuid)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.acquire_realtime_lock(uuid, integer)
  SET search_path = public, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────
-- Part 2: search_path für Funktionen die NUR in Prod-DB existieren
-- (Drift gegenüber Repo). Signaturen aus Supabase-Linter-Output.
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  func_record record;
  fn_oid oid;
BEGIN
  -- Liste: (name, args_signature_text)  — args wie pg_proc.proargtypes::regprocedure liefert
  FOR func_record IN
    SELECT * FROM (VALUES
      ('delete_sophie_user',            'uid uuid'),
      ('handle_new_user',               ''),
      ('increment_voice_usage',         'p_user_id uuid, p_chars integer'),
      ('init_user_memory',              ''),
      ('insert_conversation_message',   ''),
      ('meeting_segment_upsert',        ''),
      ('increment_meeting_cost',        ''),
      ('set_updated_at',                '')
    ) AS t(fn_name, fn_args)
  LOOP
    -- Wir lookup'en die exakte Signatur dynamisch über pg_proc — das ist
    -- robuster als hardcoded Argumenttypen, weil wir die wahre Definition
    -- in der Prod-DB nicht aus dem Repo kennen.
    FOR fn_oid IN
      SELECT p.oid
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = func_record.fn_name
    LOOP
      EXECUTE format(
        'ALTER FUNCTION %s SET search_path = public, pg_temp',
        fn_oid::regprocedure
      );
      RAISE NOTICE 'search_path set for %', fn_oid::regprocedure;
    END LOOP;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Part 3: REVOKE EXECUTE auf SECURITY DEFINER Funktionen, die laut Advisor
-- via /rest/v1/rpc/ exposed sind. Service-Role behält Zugriff (Default).
-- ─────────────────────────────────────────────────────────────────────────

-- Bekannte Funktion aus Repo (Unfiltered W1):
REVOKE EXECUTE ON FUNCTION public.unf_cleanup_expired()
  FROM PUBLIC, anon, authenticated;

-- Funktionen aus der Prod-DB (kein Repo-Source bekannt): dynamisch REVOKE
DO $$
DECLARE
  fn_oid oid;
BEGIN
  FOR fn_oid IN
    SELECT p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef = true   -- nur SECURITY DEFINER
       AND p.proname IN (
         'delete_sophie_user',
         'handle_new_user',
         'increment_voice_usage',
         'init_user_memory'
       )
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated',
      fn_oid::regprocedure
    );
    RAISE NOTICE 'EXECUTE revoked on %', fn_oid::regprocedure;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Part 4: chat_sessions INSERT-Policy hardenden (idempotent)
-- ─────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Anyone can insert chat sessions" ON public.chat_sessions;
DROP POLICY IF EXISTS "Authenticated users can insert own chat sessions"
  ON public.chat_sessions;

CREATE POLICY "Authenticated users can insert own chat sessions"
  ON public.chat_sessions
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────
-- Nicht in dieser Migration (Dashboard-Action notwendig):
--
--   Supabase Dashboard → Authentication → Settings →
--   "Leaked password protection" einschalten.
--   (HaveIBeenPwned-Check beim Login, ~100ms Latenz, blockt schwache
--   Passwörter.)
-- ─────────────────────────────────────────────────────────────────────────
