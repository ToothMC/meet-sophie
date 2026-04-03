// lib/memory-helpers.js — Shared tier→depth config + field gating
// Mirrors src/memory/memory.config.ts for server-side JS usage.

export const TIER_MEMORY_CONFIG = {
  free:      { depth: null,    ttlDays: 0  },
  assistant: { depth: "light",  ttlDays: 14 },
  friend:    { depth: "medium", ttlDays: 30 },
  partner:   { depth: "deep",   ttlDays: 60 },
};

// Which LTM fields are permitted at each depth level
const DEPTH_FIELDS = {
  light:  ["communication_style", "work_preferences", "recurring_topics", "long_term_goals"],
  medium: ["communication_style", "work_preferences", "recurring_topics", "long_term_goals",
           "personal_patterns", "emotional_tones", "typical_conflicts"],
  deep:   ["communication_style", "work_preferences", "recurring_topics", "long_term_goals",
           "personal_patterns", "emotional_tones", "typical_conflicts",
           "significant_developments", "relationship_milestones"],
};

// Filter an LTM row to only include fields permitted at the given depth
export function filterLtmByDepth(depth, row) {
  if (!depth || !row) return {};
  const allowed = new Set(DEPTH_FIELDS[depth] || []);
  const filtered = {};
  for (const [key, val] of Object.entries(row)) {
    if (allowed.has(key) || ["user_id", "id", "depth", "last_condensed_at", "created_at", "updated_at"].includes(key)) {
      filtered[key] = val;
    }
  }
  return filtered;
}

// Merge two string arrays, deduplicate, cap at maxLen
export function mergeArrays(existing, incoming, maxLen = 20) {
  const base = Array.isArray(existing) ? existing : [];
  const add = Array.isArray(incoming) ? incoming : [];
  const merged = [...new Set([...base, ...add].map(s => String(s || "").trim()).filter(Boolean))];
  return merged.slice(0, maxLen);
}

// Merge JSONB objects (shallow)
export function mergeJsonb(existing, incoming) {
  if (!incoming || typeof incoming !== "object") return existing || null;
  if (!existing || typeof existing !== "object") return incoming;
  return { ...existing, ...incoming };
}
