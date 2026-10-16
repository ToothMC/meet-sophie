-- Meeting-Folgetermine: Konfliktpruefung + direkter Kalender-Eintrag.
--
-- Eine Zeile pro (Meeting, Art, Slot). Der UNIQUE-Key ist die
-- Idempotenz-Sperre: Zeile wird VOR dem Google-Aufruf angelegt
-- (INSERT ... ON CONFLICT DO NOTHING). Nur wer die Zeile anlegt, prueft
-- bzw. traegt ein. So entstehen weder doppelte Hinweise noch doppelte
-- Kalender-Events — auch nicht zwischen Live-Check und Nach-Meeting-Pass.
--
--   kind = 'check'     — vorgeschlagener Slot, Konfliktpruefung
--   kind = 'booking'   — vereinbarter Slot, Event im Kalender
--   kind = 'time_open' — vereinbarter Tag ohne Uhrzeit (nur Hinweis)
--   slot_key           — UTC-ISO-Start (check/booking) bzw. YYYY-MM-DD (time_open)
--
-- Zugriff ausschliesslich ueber api/meeting.js + api/ai/generate-report.js
-- mit Service Role → RLS an, keine Policies (deny-all fuer anon/authenticated).

CREATE TABLE IF NOT EXISTS public.meeting_calendar_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id       uuid NOT NULL REFERENCES public.meetings(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('check', 'booking', 'time_open')),
  slot_key         text NOT NULL,
  start_at         timestamptz,
  end_at           timestamptz,
  slot_date        date,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'free', 'conflict', 'created', 'failed', 'undone', 'replaced', 'noted')),
  google_event_id  text,
  event_title      text,
  conflict_title   text,
  source           text NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'report')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, kind, slot_key)
);

CREATE INDEX IF NOT EXISTS meeting_calendar_items_meeting_idx
  ON public.meeting_calendar_items (meeting_id);

ALTER TABLE public.meeting_calendar_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.meeting_calendar_items FROM anon, authenticated;
