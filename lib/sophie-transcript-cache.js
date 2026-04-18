/**
 * sophie-transcript-cache.js
 *
 * Local cache for voice-session transcripts as a safety net when auth dies
 * mid-session (e.g. refresh_token 401 on iOS Safari/Brave). The cached
 * transcript is replayed to /api/memory-update after re-authentication.
 *
 * Contract:
 *   1. Cache key is a single localStorage slot — only one pending transcript
 *      at a time. If a newer one arrives, it overwrites the older one (same
 *      session being ticked forward).
 *   2. Cache entries have a 24h TTL. Older entries are discarded on read.
 *   3. Recovery only fires for the same user_id that created the cache —
 *      prevents leaking a prior user's transcript to a new login on the same
 *      browser.
 *   4. All functions are fail-soft: if localStorage / parse / fetch fails,
 *      return gracefully without throwing.
 */

const KEY = "sophie_pending_transcript";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Persist a snapshot of the in-flight voice session.
 * @param {object} data
 * @param {Array}  data.transcript       convoLog-style [{role, text}, ...]
 * @param {string} [data.userId]         owner — enforced on recovery
 * @param {string} [data.sessionId]
 * @param {string} [data.sessionMode]
 * @param {string} [data.startedAt]      ISO timestamp
 * @param {object} [data.realtimeUsage]
 * @param {string} [data.runId]
 */
export function cacheTranscript(data) {
  try {
    if (!data || !Array.isArray(data.transcript) || data.transcript.length === 0) return;
    const payload = { ...data, savedAt: new Date().toISOString() };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch (_) {}
}

export function clearTranscriptCache() {
  try { localStorage.removeItem(KEY); } catch (_) {}
}

export function readTranscriptCache() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.savedAt) {
      const age = Date.now() - new Date(data.savedAt).getTime();
      if (!isFinite(age) || age > MAX_AGE_MS) {
        clearTranscriptCache();
        return null;
      }
    }
    return data;
  } catch (_) {
    return null;
  }
}

/**
 * Attempt to replay a cached transcript to /api/memory-update using the
 * current Supabase session. Clears the cache on success or on user mismatch.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<{recovered: boolean, reason?: string, status?: number}>}
 */
export async function recoverPendingTranscript(supabase) {
  try {
    const data = readTranscriptCache();
    if (!data) return { recovered: false, reason: "no_cache" };

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token || !session.user?.id) {
      return { recovered: false, reason: "no_session" };
    }

    // Only replay if the cached entry belongs to the currently signed-in user.
    if (data.userId && data.userId !== session.user.id) {
      clearTranscriptCache();
      return { recovered: false, reason: "different_user" };
    }

    const secondsUsed = (data.startedAt && data.savedAt)
      ? Math.max(0, Math.round((new Date(data.savedAt) - new Date(data.startedAt)) / 1000))
      : 0;

    const res = await fetch("/api/memory-update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        transcript: data.transcript,
        seconds_used: secondsUsed,
        session_started_at: data.startedAt || null,
        session_ended_at: data.savedAt || null,
        session_id: data.sessionId || null,
        session_mode: data.sessionMode || null,
        realtime_usage: data.realtimeUsage || undefined,
        recovered: true,
      }),
    });

    if (res.ok) {
      clearTranscriptCache();
      return { recovered: true };
    }
    return { recovered: false, reason: "http_error", status: res.status };
  } catch (e) {
    return { recovered: false, reason: "exception", error: String(e && e.message || e) };
  }
}
