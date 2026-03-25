import { supabase } from '@/lib/supabase'
import { SophieMode, HistoryCardType } from './memory.enums'
import { HistoryCard } from './memory.types'
import { MODE_CONFIG } from './memory.config'
import { buildRelevanceContext } from './relevance'

// ── Modus-Historie laden ───────────────────────────────────
// Zeigt nur den Verlauf des aktiven Modus.
// Persoenliche Modi teilen sich short_term_memory (gefiltert nach mode).
// Arbeitsraeume haben eigene Tabellen.

export async function getHistoryForMode(
  userId:     string,
  mode:       SophieMode,
  limit = 20,
): Promise<HistoryCard[]> {

  const config = MODE_CONFIG[mode]

  switch (config.historyScope) {

    case 'personal': {
      const { data } = await supabase
        .from('sophie_short_term_memory')
        .select('*')
        .eq('user_id', userId)
        .eq('mode', mode)
        .gt('expires_at', new Date().toISOString())
        .order('updated_at', { ascending: false })
        .limit(limit)
      return (data ?? []).map(mapShortTermToCard)
    }

    case 'meeting': {
      const { data } = await supabase
        .from('sophie_meeting_memory')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit)
      return (data ?? []).map(mapMeetingToCard)
    }

    case 'brainstorm': {
      const { data } = await supabase
        .from('sophie_brainstorm_memory')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit)
      return (data ?? []).map(mapBrainstormToCard)
    }

    case 'sales_pitch': {
      const { data } = await supabase
        .from('sophie_pitch_memory')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit)
      return (data ?? []).map(mapPitchToCard)
    }
  }
}

// ── Mapper: ShortTermMemory -> HistoryCard ──────────────────

function mapShortTermToCard(row: any): HistoryCard {
  return {
    id:             row.id,
    type:           HistoryCardType.CONVERSATION,
    title:          row.summary?.substring(0, 80) ?? 'Untitled',
    subtitle:       row.open_topics?.length > 0
                      ? `${row.open_topics.length} offene Themen`
                      : null,
    mode:           row.mode,
    isOpen:         (row.open_topics?.length ?? 0) > 0 || (row.pending_decisions?.length ?? 0) > 0,
    relevanceScore: row.importance_score ?? 0.5,
    createdAt:      new Date(row.created_at),
    crossRefs:      [],
  }
}

// ── Mapper: MeetingMemory -> HistoryCard ────────────────────

function mapMeetingToCard(row: any): HistoryCard {
  return {
    id:             row.id,
    type:           HistoryCardType.MEETING,
    title:          row.title,
    subtitle:       row.status === 'follow_up_pending'
                      ? `${row.open_points.length} offene Punkte`
                      : null,
    mode:           SophieMode.MEETING,
    isOpen:         row.status !== 'closed',
    relevanceScore: row.open_points.length > 0 ? 0.8 : 0.5,
    createdAt:      new Date(row.created_at),
    crossRefs:      [],
  }
}

// ── Mapper: BrainstormMemory -> HistoryCard ──────────────────

function mapBrainstormToCard(row: any): HistoryCard {
  const ideas = row.ideas ?? []
  const activeCount = ideas.filter((i: any) => i.status === 'active').length
  return {
    id:             row.id,
    type:           HistoryCardType.IDEA_CLUSTER,
    title:          row.topic,
    subtitle:       activeCount > 0 ? `${activeCount} aktive Ideen` : null,
    mode:           SophieMode.BRAINSTORM,
    isOpen:         activeCount > 0,
    relevanceScore: activeCount > 0 ? 0.7 : 0.4,
    createdAt:      new Date(row.created_at),
    crossRefs:      [],
  }
}

// ── Mapper: PitchMemory -> HistoryCard ──────────────────────

function mapPitchToCard(row: any): HistoryCard {
  return {
    id:             row.id,
    type:           HistoryCardType.PITCH_SESSION,
    title:          row.topic,
    subtitle:       row.score != null ? `Score: ${row.score}/100 (v${row.version})` : null,
    mode:           SophieMode.SALES_PITCH,
    isOpen:         (row.weaknesses?.length ?? 0) > 0,
    relevanceScore: row.score != null ? row.score / 100 : 0.5,
    createdAt:      new Date(row.created_at),
    crossRefs:      [],
  }
}
