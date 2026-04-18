// ── Modus ──────────────────────────────────────────────────
// Bestimmt den aktiven Kontext einer Konversation.
// Persoenliche Modi (assistant/friend/partner) teilen sich den
// persoenlichen Verlauf. Arbeitsraeume sind vollstaendig isoliert.

export enum SophieMode {
  // Persoenliche Modi
  ASSISTANT   = 'assistant',
  FRIEND      = 'friend',
  PARTNER     = 'partner',

  // Isolierte Arbeitsraeume
  MEETING     = 'meeting',
  BRAINSTORM  = 'brainstorm',
  SALES_PITCH = 'sales_pitch',
  CALENDAR    = 'calendar',

  // Passiv-Modus (ephemeral, keine Persistenz)
  STEALTH     = 'stealth',
}

// ── Memory-Tiefe ───────────────────────────────────────────
// Steuert WIE TIEF Sophie ueber Zeit erinnert.
// Unabhaengig vom Sicherheitslevel — alle drei laufen auf Confidential.

export enum MemoryDepth {
  LIGHT  = 'light',   // Assistance — funktionale Kontinuitaet
  MEDIUM = 'medium',  // Friend — persoenlichere Kontinuitaet
  DEEP   = 'deep',    // Partner — tiefe Beziehungskontinuitaet
  SCOPED = 'scoped',  // Arbeitsraeume — modus-isoliert, keine Tiefenstufe
}

// ── Gedaechtnisebene ────────────────────────────────────────
// Welche der 5 Erinnerungsebenen ein Eintrag betrifft.

export enum MemoryLayer {
  ACUTE      = 'acute',      // A — laufende Session (in-memory only)
  SHORT_TERM = 'short_term', // B — letzte Sessions (persistiert, TTL)
  LONG_TERM  = 'long_term',  // C — dauerhaftes Profil
  SCOPED     = 'scoped',     // D — modus-spezifisch
  RELEVANCE  = 'relevance',  // E — berechnete Relevanzschicht (kein direkter Write)
}

// ── Sicherheitsstufe ───────────────────────────────────────

export enum SecurityLevel {
  CONFIDENTIAL = 'confidential', // Standard fuer alle User
  ENTERPRISE   = 'enterprise',   // Opt-in fuer gewerbliche Nutzung
}

// ── Relevanz-Signaltypen ───────────────────────────────────

export enum RelevanceSignal {
  ACTIVE_MODE    = 'active_mode',
  CURRENT_TOPIC  = 'current_topic',
  OPEN_TASK      = 'open_task',
  RECENCY        = 'recency',
  IMPORTANCE     = 'importance',
  RECURRENCE     = 'recurrence',
  USER_MARKED    = 'user_marked',
  CROSS_MODE_REF = 'cross_mode_ref',
}

// ── Historien-Kartentyp ────────────────────────────────────
// Was in der UI als Karte dargestellt wird.

export enum HistoryCardType {
  CONVERSATION  = 'conversation',
  MEETING       = 'meeting',
  IDEA_CLUSTER  = 'idea_cluster',
  PITCH_SESSION = 'pitch_session',
  OPEN_THREAD   = 'open_thread',
  CROSS_REF     = 'cross_ref',
}
