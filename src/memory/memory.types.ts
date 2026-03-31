import { SophieMode, MemoryDepth, MemoryLayer, SecurityLevel, HistoryCardType, RelevanceSignal } from './memory.enums'

// ── Akut-Gedaechtnis (A) ────────────────────────────────────
// In-memory only. Wird NICHT persistiert.
// Lebt nur in der laufenden Session (React state / Zustand store).

export interface AcuteMemory {
  sessionId:        string
  activeMode:       SophieMode
  currentTopic:     string | null
  conversationGoal: string | null
  openQuestion:     string | null
  lastStatement:    string | null
  currentTone:      string | null
  turnCount:        number
  startedAt:        Date
}

// ── Kurzzeitgedaechtnis (B) ─────────────────────────────────
// Persistiert in Supabase. TTL: 30 Tage (konfigurierbar per Mode).
// Tabelle: sophie_short_term_memory

export interface ShortTermMemory {
  id:               string           // uuid
  userId:           string           // fk -> auth.users
  mode:             SophieMode
  summary:          string           // verdichtete Zusammenfassung
  openTopics:       string[]
  pendingDecisions: string[]
  nextSteps:        string[]
  importanceScore:  number           // 0-1, berechnet
  expiresAt:        Date
  createdAt:        Date
  updatedAt:        Date
  conversationId:   string           // fk -> chat_sessions
}

// ── Langzeitgedaechtnis (C) ─────────────────────────────────
// Persistiert. Kein Ablaufdatum. Wird periodisch verdichtet.
// Tabelle: user_profile (bereits vorhanden) + sophie_long_term_memory

export interface LongTermMemory {
  id:                       string
  userId:                   string
  depth:                    MemoryDepth      // light | medium | deep

  // Basis — alle Depths
  communicationStyle:       string | null
  workPreferences:          Record<string, unknown> | null
  recurringTopics:          string[]
  longTermGoals:            string[]

  // Erweitert — ab medium
  personalPatterns:         string[] | null
  emotionalTones:           string[] | null
  typicalConflicts:         string[] | null

  // Tief — nur deep
  significantDevelopments:  string[] | null
  relationshipMilestones:  string[] | null

  lastCondensedAt:          Date
  createdAt:                Date
  updatedAt:                Date
}

// ── Modus-Gedaechtnis (D) ───────────────────────────────────
// Je Arbeitsraum eigene Tabellen. Vollstaendig isoliert.

export interface MeetingMemory {
  id:           string
  userId:       string
  title:        string
  participants: string[]
  decisions:    string[]
  openPoints:   string[]
  followUps:    MeetingFollowUp[]
  risks:        string[]
  conflicts:    string[]
  status:       'open' | 'closed' | 'follow_up_pending'
  sessionId:    string
  createdAt:    Date
}

export interface MeetingFollowUp {
  text:       string
  owner:      string | null
  dueDate:    Date | null
  completed:  boolean
}

export interface BrainstormMemory {
  id:               string
  userId:           string
  topic:            string
  ideas:            BrainstormIdea[]
  clusters:         string[]
  prioritizedIdeas: string[]   // idea ids
  discardedIdeas:   string[]   // idea ids
  linkedMeetingId:  string | null
  linkedPitchId:    string | null
  sessionId:        string
  createdAt:        Date
}

export interface BrainstormIdea {
  id:        string
  text:      string
  cluster:   string | null
  score:     number   // 0-1
  status:    'active' | 'prioritized' | 'discarded'
}

export interface PitchContentScores {
  clarity:           number  // 1-5, weight 12%
  problemSharpness:  number  // 1-5, weight 10%
  valueProposition:  number  // 1-5, weight 12%
  structure:         number  // 1-5, weight 8%
  differentiation:   number  // 1-5, weight 8%
  credibility:       number  // 1-5, weight 5%
  audienceFit:       number  // 1-5, weight 5%
}

export interface PitchDeliveryScores {
  opening:           number  // 1-5, weight 8%
  closing:           number  // 1-5, weight 7%
  voiceRhythm:       number  // 1-5, weight 8%
  rhetoricLanguage:  number  // 1-5, weight 7%
  authenticity:      number  // 1-5, weight 5%
  persuasiveness:    number  // 1-5, weight 5%
}

export type PitchType = 'sales' | 'investor' | 'keynote' | 'internal' | 'self' | 'other'
export type GoalType = 'buy' | 'invest' | 'approve' | 'trust' | 'understand' | 'remember' | 'decide'
export type ConfidenceLevel = 'low' | 'medium' | 'high'

export interface PitchMemory {
  id:                  string
  userId:              string
  pitchTopic:          string
  pitchType:           PitchType
  audienceType:        'investor' | 'customer' | 'partner' | 'leadership' | 'public' | 'jury' | 'mixed'
  goalType:            GoalType
  overallScore:        number          // 1.0-5.0 (weighted average)
  scoresContent:       PitchContentScores
  scoresDelivery:      PitchDeliveryScores
  confidenceLevel:     ConfidenceLevel
  recurringStrengths:  string[]
  recurringWeaknesses: string[]
  versionLabel:        string | null
  version:             number
  parentPitchId:       string | null   // for version chain
  sessionId:           string
  createdAt:           Date
}

// ── Relevanz-Kontext (E) ───────────────────────────────────
// Wird berechnet, NICHT direkt geschrieben.

export interface RelevanceContext {
  userId:        string
  activeMode:    SophieMode
  relevantItems: RelevantItem[]
  computedAt:    Date
}

export interface RelevantItem {
  sourceId:       string
  sourceType:     MemoryLayer
  score:          number          // 0-1
  signals:        RelevanceSignal[]
  label:          string          // UI-Anzeige
  isCrossMode:    boolean
  crossModeHint:  string | null   // z.B. "Relevant aus Brainstorming"
}

// ── Historien-Karte (UI) ───────────────────────────────────

export interface HistoryCard {
  id:              string
  type:            HistoryCardType
  title:           string
  subtitle:        string | null
  mode:            SophieMode
  isOpen:          boolean          // hat offene Punkte
  relevanceScore:  number
  createdAt:       Date
  crossRefs:       CrossModeRef[]
}

export interface CrossModeRef {
  fromMode:  SophieMode
  targetId:  string
  hint:      string          // "Daraus entstand Pitch-Version 3"
}
