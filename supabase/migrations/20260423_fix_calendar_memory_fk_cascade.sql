-- sophie_calendar_memory.session_id blockte die Löschung von user_sessions-
-- Zeilen, wenn während der Session ein Calendar-Memory-Eintrag entstanden
-- war. Andere Tabellen (conversation_outputs, conversation_messages,
-- sophie_short_term_memory) cascaden bereits — nur diese FK war auf
-- Default NO ACTION.
--
-- Folge: "Löschen" in /app/reports scheiterte still (api/settings
-- schluckte den FK-Error), UI entfernte den Eintrag temporär, Reload
-- brachte ihn zurück.

BEGIN;

ALTER TABLE sophie_calendar_memory
  DROP CONSTRAINT IF EXISTS sophie_calendar_memory_session_id_fkey;

ALTER TABLE sophie_calendar_memory
  ADD CONSTRAINT sophie_calendar_memory_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES user_sessions(id) ON DELETE CASCADE;

COMMIT;
