-- Laufende Witze (Running Gags) zwischen Sophie und dem User, ueber Sessions
-- hinweg. Wird von api/memory-update.js gepflegt (neueste zuerst, max 8) und
-- in lib/sophie-core.js (_memoryContext) in den Prompt geladen.
alter table public.sophie_long_term_memory
  add column if not exists running_jokes text[] not null default '{}'::text[];
