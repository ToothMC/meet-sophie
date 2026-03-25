import { RelevanceSignal, SophieMode } from './memory.enums'
import { MODE_CONFIG } from './memory.config'
import { RelevantItem, RelevanceContext } from './memory.types'

// ── Relevanz-Gewichte ──────────────────────────────────────
// Summiert auf max. 1.0 pro Item. Mehrere Signale addieren sich.

export const SIGNAL_WEIGHTS: Record<RelevanceSignal, number> = {
  [RelevanceSignal.ACTIVE_MODE]:    0.35,  // gleicher Modus wie aktiv
  [RelevanceSignal.CURRENT_TOPIC]:  0.25,  // Thema passt zum aktuellen
  [RelevanceSignal.OPEN_TASK]:      0.20,  // hat offene Punkte / Follow-ups
  [RelevanceSignal.RECENCY]:        0.15,  // letzte 7 Tage: voll, bis 30 T: linear
  [RelevanceSignal.IMPORTANCE]:     0.20,  // importance_score des Eintrags
  [RelevanceSignal.RECURRENCE]:     0.10,  // wiederkehrendes Thema
  [RelevanceSignal.USER_MARKED]:    0.30,  // User hat explizit markiert
  [RelevanceSignal.CROSS_MODE_REF]: 0.15,  // Verweis aus erlaubtem Modus
}

export const RELEVANCE_THRESHOLD = 0.4   // unter diesem Score: nicht anzeigen
export const MAX_VISIBLE_ITEMS   = 8     // max. Karten in der Relevanzflaeche

// ── Recency Score berechnen ────────────────────────────────

export function calcRecencyScore(createdAt: Date): number {
  const ageInDays = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24)
  if (ageInDays <= 7)  return 1.0
  if (ageInDays >= 30) return 0.0
  return 1 - ((ageInDays - 7) / (30 - 7))  // linear decay
}

// ── Haupt-Scoring ──────────────────────────────────────────

export function scoreItem(
  signals:         RelevanceSignal[],
  importanceScore: number,
  createdAt:       Date,
): number {
  let score = 0

  for (const signal of signals) {
    if (signal === RelevanceSignal.RECENCY) {
      score += SIGNAL_WEIGHTS[signal] * calcRecencyScore(createdAt)
    } else if (signal === RelevanceSignal.IMPORTANCE) {
      score += SIGNAL_WEIGHTS[signal] * importanceScore
    } else {
      score += SIGNAL_WEIGHTS[signal]
    }
  }

  return Math.min(score, 1.0)
}

// ── Cross-Mode-Guard ───────────────────────────────────────
// Prueft ob activeMode Items aus sourceMode lesen darf.

export function canReadCrossMode(
  activeMode: SophieMode,
  sourceMode: SophieMode,
): boolean {
  if (activeMode === sourceMode) return true
  return MODE_CONFIG[activeMode].crossModeRead.includes(sourceMode)
}

// ── Relevanzkontext aufbauen ───────────────────────────────

export function buildRelevanceContext(
  userId:      string,
  activeMode:  SophieMode,
  candidates:  RelevantItem[],
): RelevanceContext {
  const visible = candidates
    .filter(item =>
      item.score >= RELEVANCE_THRESHOLD &&
      (!item.isCrossMode || canReadCrossMode(activeMode, item.sourceType as unknown as SophieMode))
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_VISIBLE_ITEMS)

  return { userId, activeMode, relevantItems: visible, computedAt: new Date() }
}
