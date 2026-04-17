-- =========================================================
-- user_sessions.has_chat_notes + conversation_messages.source
--
-- Hintergrund:
-- - api/session.js?action=chat_note fügt während Voice-Sessions Sophie-Chat-
--   Nachrichten in conversation_messages ein (send_chat_note Tool).
-- - api/memory-update.js schreibt am Session-Ende den kompletten Voice-
--   Transcript ebenfalls in conversation_messages.
-- - Beides lebt in der gleichen Tabelle. Der Chats-Tab soll NUR die echten
--   Chat-Nachrichten zeigen, nicht den Transcript des Gesprächs.
-- =========================================================

-- 1) Flag auf user_sessions: "diese Session enthält echte Chat-Nachrichten"
alter table public.user_sessions
  add column if not exists has_chat_notes boolean not null default false;

create index if not exists user_sessions_has_chat_notes_idx
  on public.user_sessions (user_id, has_chat_notes)
  where has_chat_notes = true;

-- 2) Source-Spalte auf conversation_messages: chat_note vs. transcript
alter table public.conversation_messages
  add column if not exists source text not null default 'transcript'
    check (source in ('transcript', 'chat_note'));

create index if not exists conversation_messages_source_idx
  on public.conversation_messages (session_id, source);

-- 3) Backfill (idempotent).
-- Die 7 Legacy-Rows mit session_type='voice' wurden ausschließlich durch
-- chat_note upserted und enthalten genau eine conversation_message — Sophies
-- Chat-Nachricht. Die markieren wir als chat_note. Alle übrigen Transcripts
-- bleiben auf 'transcript' (default).
update public.user_sessions us
  set has_chat_notes = true
  where us.session_type = 'voice'
    and exists (select 1 from public.conversation_messages cm where cm.session_id = us.id)
    and us.has_chat_notes = false;

update public.conversation_messages cm
  set source = 'chat_note'
  where cm.source = 'transcript'
    and exists (
      select 1 from public.user_sessions us
      where us.id = cm.session_id
        and us.has_chat_notes = true
        and us.session_type = 'voice'
    );
