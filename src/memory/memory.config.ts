import { SophieMode, MemoryDepth, SecurityLevel } from './memory.enums'

// ── Modus-Config Interface ────────────────────────────────

export interface ModeConfig {
  depth:            MemoryDepth
  security:         SecurityLevel
  isWorkspace:      boolean
  shortTermTTLDays: number
  historyScope:     'personal' | 'meeting' | 'brainstorm' | 'sales_pitch' | 'ephemeral'
  crossModeRead:    SophieMode[]  // Modi, aus denen Refs gezogen werden duerfen
  label:            string
  // Stealth / Listen-Modi: nichts wird persistiert, kein Transcript, kein Report
  ephemeral?:       boolean
  persistTranscript?: boolean
}

// ── Modus -> Memory-Konfiguration ──────────────────────────

export const MODE_CONFIG: Record<SophieMode, ModeConfig> = {

  [SophieMode.ASSISTANT]: {
    depth:            MemoryDepth.LIGHT,
    security:         SecurityLevel.CONFIDENTIAL,
    isWorkspace:      false,
    shortTermTTLDays: 14,
    historyScope:     'personal',
    crossModeRead:    [],                          // darf nicht in andere Modi schauen
    label:            'Assistant',
  },

  [SophieMode.FRIEND]: {
    depth:            MemoryDepth.MEDIUM,
    security:         SecurityLevel.CONFIDENTIAL,
    isWorkspace:      false,
    shortTermTTLDays: 30,
    historyScope:     'personal',
    crossModeRead:    [],
    label:            'Friend',
  },

  [SophieMode.PARTNER]: {
    depth:            MemoryDepth.DEEP,
    security:         SecurityLevel.CONFIDENTIAL,
    isWorkspace:      false,
    shortTermTTLDays: 60,
    historyScope:     'personal',
    crossModeRead:    [],
    label:            'Partner',
  },

  [SophieMode.MEETING]: {
    depth:            MemoryDepth.SCOPED,
    security:         SecurityLevel.CONFIDENTIAL,  // Enterprise optional
    isWorkspace:      true,
    shortTermTTLDays: 90,
    historyScope:     'meeting',
    crossModeRead:    [SophieMode.BRAINSTORM],     // darf Brainstorm-Refs sehen
    label:            'Meeting',
  },

  [SophieMode.BRAINSTORM]: {
    depth:            MemoryDepth.SCOPED,
    security:         SecurityLevel.CONFIDENTIAL,
    isWorkspace:      true,
    shortTermTTLDays: 90,
    historyScope:     'brainstorm',
    crossModeRead:    [SophieMode.MEETING, SophieMode.SALES_PITCH],
    label:            'Brainstorming',
  },

  [SophieMode.SALES_PITCH]: {
    depth:            MemoryDepth.SCOPED,
    security:         SecurityLevel.CONFIDENTIAL,
    isWorkspace:      true,
    shortTermTTLDays: 90,
    historyScope:     'sales_pitch',
    crossModeRead:    [SophieMode.BRAINSTORM],
    label:            'Sales Pitch',
  },

  [SophieMode.CALENDAR]: {
    depth:            MemoryDepth.SCOPED,
    security:         SecurityLevel.CONFIDENTIAL,
    isWorkspace:      true,
    shortTermTTLDays: 90,
    historyScope:     'personal',              // Kalender-Kontext fliesst in persoenliche Historie
    crossModeRead:    [SophieMode.MEETING, SophieMode.BRAINSTORM],  // darf Meeting- und Brainstorm-Refs sehen
    label:            'Calendar',
  },

  [SophieMode.STEALTH]: {
    depth:            MemoryDepth.SCOPED,
    security:         SecurityLevel.CONFIDENTIAL,
    isWorkspace:      false,
    shortTermTTLDays: 0,                       // nichts wird persistiert
    historyScope:     'ephemeral',
    crossModeRead:    [],                      // liest nichts, schreibt nichts
    label:            'Stealth',
    ephemeral:        true,
    persistTranscript: false,
  },
}

// ── Depth -> was gespeichert werden darf ───────────────────

export interface DepthPermissions {
  canStoreCommunicationStyle: boolean
  canStoreWorkPreferences:    boolean
  canStoreRecurringTopics:    boolean
  canStoreLongTermGoals:      boolean
  canStorePersonalPatterns:   boolean
  canStoreEmotionalTones:     boolean
  canStoreTypicalConflicts:   boolean
  canStoreRelationshipData:   boolean
}

export const DEPTH_PERMISSIONS: Record<MemoryDepth, DepthPermissions> = {
  [MemoryDepth.LIGHT]: {
    canStoreCommunicationStyle: true,
    canStoreWorkPreferences:    true,
    canStoreRecurringTopics:    true,
    canStoreLongTermGoals:      true,
    canStorePersonalPatterns:   false,
    canStoreEmotionalTones:     false,
    canStoreTypicalConflicts:   false,
    canStoreRelationshipData:   false,
  },
  [MemoryDepth.MEDIUM]: {
    canStoreCommunicationStyle: true,
    canStoreWorkPreferences:    true,
    canStoreRecurringTopics:    true,
    canStoreLongTermGoals:      true,
    canStorePersonalPatterns:   true,
    canStoreEmotionalTones:     true,
    canStoreTypicalConflicts:   true,
    canStoreRelationshipData:   false,
  },
  [MemoryDepth.DEEP]: {
    canStoreCommunicationStyle: true,
    canStoreWorkPreferences:    true,
    canStoreRecurringTopics:    true,
    canStoreLongTermGoals:      true,
    canStorePersonalPatterns:   true,
    canStoreEmotionalTones:     true,
    canStoreTypicalConflicts:   true,
    canStoreRelationshipData:   true,
  },
  [MemoryDepth.SCOPED]: {
    // Arbeitsraeume — keine personal depth
    canStoreCommunicationStyle: false,
    canStoreWorkPreferences:    false,
    canStoreRecurringTopics:    false,
    canStoreLongTermGoals:      false,
    canStorePersonalPatterns:   false,
    canStoreEmotionalTones:     false,
    canStoreTypicalConflicts:   false,
    canStoreRelationshipData:   false,
  },
}
