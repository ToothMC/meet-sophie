-- Sophie Unfiltered — eigene News-Quellen pro User.
-- User trägt RSS-Feeds oder Domains ein (z.B. tagesschau.de,
-- cyprus-mail.com). Wir versuchen Auto-Discover; bei Domains suchen
-- wir nach <link rel="alternate" type="application/rss+xml"> oder den
-- üblichen Pfaden /feed, /rss, /atom.xml.

BEGIN;

ALTER TABLE public.unf_boundaries
  ADD COLUMN IF NOT EXISTS custom_feeds text[] NOT NULL DEFAULT '{}';

-- Optional: kurze Beschreibung pro Feed (resolved-URL + Titel) wird
-- vom Backend lazy beim ersten erfolgreichen Fetch in einem JSONB-Feld
-- gepflegt. So muss der User nur die URL eintragen, das Label kommt
-- automatisch.
ALTER TABLE public.unf_boundaries
  ADD COLUMN IF NOT EXISTS custom_feeds_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
