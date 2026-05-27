// lib/unfiltered/memory.js — Unfiltered Memory-Tier (Read-Side).
//
// Lädt für Realtime-Session relevante Story-Threads, Events und Boundaries.
// Schreib-Seite (condenseSessionToUnfiltered) lebt in W3 als eigener Endpoint.
//
// Alle Funktionen erwarten einen Service-Role-Client (RLS gilt nicht), da
// sie aus api/unfiltered/toggle.js heraus aufgerufen werden und bereits
// einen authentifizierten user_id-Kontext haben.

const DEFAULT_THREAD_LIMIT = 5;
const DEFAULT_EVENT_LIMIT  = 10;

/**
 * Lädt für die Realtime-Session relevante Threads + Events.
 * Rangordnung: zuletzt aktiv > Status open/paused > höhere Confidence.
 *
 * @param {Object} supabase  Service-Role-Client
 * @param {string} userId    auth.uid
 * @param {Object} opts
 * @param {number} [opts.limit_threads]  default 5
 * @param {number} [opts.limit_events]   default 10
 * @returns {Promise<{threads: Array, events: Array}>}
 */
export async function loadRelevantThreads(supabase, userId, opts = {}) {
  const limitThreads = Math.max(1, Math.min(20, opts.limit_threads || DEFAULT_THREAD_LIMIT));
  const limitEvents  = Math.max(1, Math.min(50, opts.limit_events  || DEFAULT_EVENT_LIMIT));

  let threads = [];
  let events  = [];

  try {
    const { data, error } = await supabase
      .from("unf_threads")
      .select("id, title, people, suspected_dynamic, status, story_score, sensitivity, last_update")
      .eq("user_id", userId)
      .in("status", ["open", "paused"])
      .order("last_update", { ascending: false })
      .limit(limitThreads);

    if (error) {
      // Tabelle fehlt? → gracefully zurückgeben (Migration noch nicht applied)
      console.warn("[unfiltered/memory] threads load failed:", error.message);
      return { threads: [], events: [] };
    }
    threads = Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn("[unfiltered/memory] threads load threw:", err.message);
    return { threads: [], events: [] };
  }

  if (!threads.length) return { threads: [], events: [] };

  try {
    const ids = threads.map(t => t.id);
    const { data, error } = await supabase
      .from("unf_events")
      .select("id, thread_id, happened_at, what, quote, user_feeling, sophie_take, next_watch_signal")
      .in("thread_id", ids)
      .order("happened_at", { ascending: false })
      .limit(limitEvents);

    if (error) {
      console.warn("[unfiltered/memory] events load failed:", error.message);
      events = [];
    } else {
      events = Array.isArray(data) ? data : [];
    }
  } catch (err) {
    console.warn("[unfiltered/memory] events load threw:", err.message);
    events = [];
  }

  return { threads, events };
}

/**
 * Lädt unf_boundaries für den User. Fehlende Row → leere Defaults.
 *
 * @param {Object} supabase
 * @param {string} userId
 * @returns {Promise<Object>}
 */
export async function loadBoundaries(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from("unf_boundaries")
      .select("blocked_people, avoid_topics, no_memory_people, default_retention_days, anonymize_names, interests, geo_country, custom_feeds, custom_feeds_meta")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      console.warn("[unfiltered/memory] boundaries load failed:", error.message);
      return {};
    }
    return data || {};
  } catch (err) {
    console.warn("[unfiltered/memory] boundaries load threw:", err.message);
    return {};
  }
}

/**
 * Lädt heutiges Briefing für den User. Optional, nur wenn explizit angefordert.
 *
 * @param {Object} supabase
 * @param {string} userId
 * @param {string} language "de" | "en"
 * @returns {Promise<Array>}
 */
export async function loadTodaysBriefing(supabase, userId, language = "de") {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { data, error } = await supabase
      .from("unf_briefings")
      .select("stories")
      .eq("user_id", userId)
      .eq("briefing_date", today)
      .eq("language", language)
      .maybeSingle();
    if (error) {
      console.warn("[unfiltered/memory] briefing load failed:", error.message);
      return [];
    }
    return Array.isArray(data?.stories) ? data.stories : [];
  } catch (err) {
    console.warn("[unfiltered/memory] briefing load threw:", err.message);
    return [];
  }
}
