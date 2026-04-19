-- +Intelligence (xi) Privacy-Consent-Persistence.
-- § 201 StGB (DE) / § 120 StGB (AT) verlangt für das Mithören fremder
-- Gespräche nachweisbare Zustimmung. Bisher war die Einwilligung nur
-- ein Header (`x-sophie-xi-privacy-ack: 1`) ohne Audit-Trail — rechtlich
-- nicht haltbar.
--
-- Jede Zustimmung landet als eigene Zeile inkl. Version + Zeitstempel,
-- damit bei Policy-Änderungen eine erneute Einwilligung erzwungen
-- werden kann (über die version-Spalte).

BEGIN;

CREATE TABLE IF NOT EXISTS xi_privacy_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  ip_hash text
);

CREATE INDEX IF NOT EXISTS idx_xi_privacy_acceptances_lookup
  ON xi_privacy_acceptances(user_id, version, accepted_at DESC);

-- Service-Role-only — Clients lesen/schreiben ausschliesslich via
-- /api/extra-intelligence/accept-privacy resp. /api/session.
ALTER TABLE xi_privacy_acceptances ENABLE ROW LEVEL SECURITY;

COMMIT;
