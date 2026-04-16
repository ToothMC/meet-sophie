-- =========================================================
-- Memory Tiering — Recap Spalten an conversation_outputs
-- =========================================================
-- Kontext: 4-Tier Memory Modell (N/K/M/L).
-- Tier N speichert pro Session einen ~150-Token strukturierten Recap,
-- der beim naechsten Session-Start geladen wird statt gekuerzte Transkript-Snippets.
-- Additiv, keine Breaking Changes — bestehende Zeilen bleiben gueltig mit NULL.
-- =========================================================

begin;

alter table public.conversation_outputs
  add column if not exists recap_text text,
  add column if not exists recap_generated_at timestamptz;

-- Abfrage-Pfad: "letzte N Sessions eines Users mit Recap" pro Modus.
-- Index beschleunigt Tier-N und Tier-K Ladungen in api/session.js.
create index if not exists conversation_outputs_recap_idx
  on public.conversation_outputs (session_id, recap_generated_at desc)
  where recap_text is not null;

commit;
