// lib/knowledge-core.js — Cross-Mode Knowledge (gemeinsames Gedaechtnis aller Modi)
//
// Talk, Chat, Brainstorm, Sales Pitch und Meeting schreiben am Session-Ende
// Wissens-Eintraege (Aufgabe, Beschluss, Idee, offene Frage, Pitch-Feedback,
// Session-Recap) nach sophie_knowledge_items. Vor dem Schreiben prueft ein
// gebuendelter AI-Call jeden Kandidaten gegen die aehnlichsten bestehenden
// Eintraege: neu / Duplikat / Aktualisierung / Widerspruch + Autoritaet.
//
// Regeln (Plan v2):
//   - +Intelligence (xi) wird NIE gelesen oder geschrieben (Guard + DB-Constraint).
//   - Status wird hier NIE geaendert (kein automatisches "erledigt").
//   - Ein Widerspruch ersetzt nur bei gleicher oder hoeherer Autoritaet.
//   - Historie wird nie geloescht, nur superseded. Jede Aenderung = Event.
//   - Idempotent ueber idem_key / alias_keys: Report-Retries und Backfill
//     erzeugen keine Duplikate.
//   - Fehlt die Migration, wird still uebersprungen (Schema-vor-Code-Regel).

import { calculateCost } from "./ai/types.js";
import { trackCost } from "./ai/cost-tracker.js";

const EMBED_MODEL = "text-embedding-3-small";
const VALIDATE_MODEL = process.env.MEMORY_MODEL || "gpt-4o-mini";
const MAX_CANDIDATES = 25;
const MAX_TEXT = 4000;
const NEIGHBORS = 5;
const MIN_MERGE_CONFIDENCE = 0.6;
const SAME_SESSION_SIM = 0.8;

const KNOWLEDGE_MODES = new Set(["talk", "chat", "brainstorm", "sales_pitch", "meeting"]);
const AUTHORITY_RANK = { tentative: 1, stated: 2, binding: 3 };

// ---------------------------------------------------------
// Mode guard — single source of truth for "which modes share knowledge"
// ---------------------------------------------------------
export function knowledgeModeFor({ sessionMode, sessionType, channel } = {}) {
  const tokens = [sessionMode, sessionType].map((m) => String(m || "").toLowerCase());
  if (tokens.some((m) => m === "extra_intelligence" || m === "xi")) return null;
  for (const m of tokens) {
    if (m === "salespitch" || m === "sales_pitch") return "sales_pitch";
    if (m === "brainstorm") return "brainstorm";
    if (m === "meeting") return "meeting";
  }
  return channel === "chat" || tokens.includes("chat") ? "chat" : "talk";
}

function isMissingSchema(err) {
  if (!err) return false;
  const msg = String(err.message || "");
  return err.code === "42P01" || err.code === "PGRST205" || err.code === "42883" ||
    /does not exist|Could not find the (table|function)/i.test(msg);
}

function clip(s, n = MAX_TEXT) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

function itemText(x) {
  if (!x) return "";
  if (typeof x === "string") return x;
  return x.text || x.title || x.task || x.description || x.label || "";
}

// ---------------------------------------------------------
// OpenAI helpers
// ---------------------------------------------------------
async function track(userId, model, usage, reason) {
  try {
    const inTok = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
    const outTok = usage?.output_tokens ?? 0;
    await trackCost({
      userId: userId || null,
      provider: "openai",
      model,
      inputTokens: inTok,
      outputTokens: outTok,
      costUsd: calculateCost(model, inTok, outTok),
      latencyMs: 0,
      routingReason: reason,
    });
  } catch { /* non-fatal */ }
}

export async function embedTexts(texts, userId = null) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !texts.length) return texts.map(() => null);
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts.map((t) => clip(t, 8000)) }),
  });
  if (!r.ok) throw new Error(`embeddings ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const out = await r.json();
  track(userId, EMBED_MODEL, out?.usage, "knowledge-embed");
  const vecs = texts.map(() => null);
  for (const d of out?.data || []) vecs[d.index] = d.embedding;
  return vecs;
}

async function callJson({ system, user, schemaName, schema, userId, reason, maxTokens = 2000 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VALIDATE_MODEL,
      input: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.1,
      max_output_tokens: maxTokens,
      truncation: "auto",
      text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
    }),
  });
  if (!r.ok) throw new Error(`${reason} ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const out = await r.json();
  track(userId, VALIDATE_MODEL, out?.usage, reason);
  const text = out?.output_text || out?.output?.[0]?.content?.find?.((c) => c.type === "output_text")?.text || "";
  return JSON.parse(text);
}

// ---------------------------------------------------------
// Brainstorm: structured ideas (nothing structured existed before)
// ---------------------------------------------------------
const IDEAS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ideas"],
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "favorite", "next_step"],
        properties: {
          text: { type: "string" },
          favorite: { type: "boolean" },
          next_step: { type: "string" },
        },
      },
    },
  },
};

export async function extractBrainstormIdeas(transcriptText, userId = null) {
  let t = String(transcriptText || "").trim();
  if (t.length < 40) return [];
  if (t.length > 12000) t = "[...earlier part trimmed...]\n" + t.slice(-12000);
  const res = await callJson({
    system: `You extract the distinct ideas developed in a brainstorming session between a user and Sophie.
- One entry per idea, as ONE self-contained sentence (what the idea is + its core point), in the same language as the session.
- Only ideas that were actually developed in the session. Never invent or merge unrelated ideas.
- favorite = true only if the user clearly preferred, chose or got excited about this idea.
- next_step = a concrete next step if one was named, otherwise "".
- At most 10 ideas. No ideas → empty list.`,
    user: `TRANSCRIPT:\n${t}`,
    schemaName: "brainstorm_ideas",
    schema: IDEAS_SCHEMA,
    userId,
    reason: "knowledge-ideas",
    maxTokens: 1200,
  });
  return Array.isArray(res?.ideas) ? res.ideas.slice(0, 10) : [];
}

// ---------------------------------------------------------
// Candidate builders (pure)
// ---------------------------------------------------------
export function candidatesFromMeeting(sessionId, structured) {
  if (!structured) return [];
  const out = [];
  (structured.decisions || []).forEach((d, i) => {
    const text = clip(itemText(d));
    if (text) out.push({ kind: "decision", authorityHint: "binding", text, idem_key: `meeting:${sessionId}:decision:${i}`,
      detail: { owner: d?.owner || "" }, source_ref: { table: "meeting_summary", session_id: sessionId, field: "decisions", index: i } });
  });
  (structured.action_items || []).forEach((a, i) => {
    const text = clip(itemText(a));
    if (text) out.push({ kind: "task", authorityHint: "binding", text, idem_key: `meeting:${sessionId}:action:${i}`,
      detail: { owner: a?.owner || a?.assignee || "", due: a?.due || "" }, source_ref: { table: "meeting_summary", session_id: sessionId, field: "action_items", index: i } });
  });
  (structured.open_points || []).forEach((p, i) => {
    const text = clip(itemText(p));
    if (text) out.push({ kind: "open_question", authorityHint: "tentative", text, idem_key: `meeting:${sessionId}:open:${i}`,
      detail: {}, source_ref: { table: "meeting_summary", session_id: sessionId, field: "open_points", index: i } });
  });
  return out;
}

// sessionTitle wins over pitch.topic: the pitch report compares with the user's LAST pitch
// of any topic and then tends to reuse that pitch's title/audience (seen 2026-10-16: a pitch
// to a carpenter stored as an old "investors" pitch). The session title comes from the
// actual conversation. Audience and version stay in detail only — not reliable enough for text.
export function candidateFromPitch(pitch, sessionTitle = "") {
  if (!pitch?.id) return [];
  const list = (arr) => (Array.isArray(arr) ? arr : []).map(itemText).filter(Boolean).slice(0, 3).join("; ");
  const title = clip(sessionTitle, 120) || clip(pitch.topic, 120);
  const parts = [`Sales pitch "${title}": score ${pitch.score ?? "?"}/100.`];
  const s = list(pitch.strengths); if (s) parts.push(`Strengths: ${s}.`);
  const w = list(pitch.weaknesses); if (w) parts.push(`Weaknesses: ${w}.`);
  return [{
    kind: "pitch_feedback", authorityHint: "stated", text: clip(parts.join(" ")), topic: title,
    idem_key: `pitch:${pitch.id}`,
    detail: { score: pitch.score ?? null, version: pitch.version || 1, pitch_id: pitch.id, parent_pitch_id: pitch.parent_pitch_id || null,
      report_topic: clip(pitch.topic, 120) || null, audience: pitch.target_audience && pitch.target_audience !== "string" ? clip(pitch.target_audience, 80) : null },
    source_ref: { table: "sophie_pitch_memory", id: pitch.id },
  }];
}

export function candidatesFromStm(sessionId, stm) {
  if (!stm) return [];
  const out = [];
  const add = (arr, field, kind, hint) => (Array.isArray(arr) ? arr : []).forEach((x, i) => {
    const text = clip(itemText(x));
    if (text) out.push({ kind, authorityHint: hint, text, idem_key: `stm:${sessionId}:${field}:${i}`, detail: {},
      source_ref: { table: "sophie_short_term_memory", id: stm.id || null, field, index: i } });
  });
  add(stm.next_steps, "next_steps", "task", "stated");
  add(stm.pending_decisions, "pending_decisions", "open_question", "tentative");
  add(stm.open_topics, "open_topics", "open_question", "tentative");
  return out;
}

export function candidatesFromIdeas(sessionId, ideas) {
  return (ideas || []).map((idea, i) => ({
    kind: "idea", authorityHint: "tentative", text: clip(idea.text), idem_key: `idea:${sessionId}:${i}`,
    detail: { favorite: !!idea.favorite, next_step: clip(idea.next_step, 300) },
    source_ref: { table: "conversation_messages", session_id: sessionId, field: "brainstorm_ideas", index: i },
  })).filter((c) => c.text);
}

// ---------------------------------------------------------
// Validation (one bundled call per session)
// ---------------------------------------------------------
const VALIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "keep", "kind", "authority", "action", "target_id", "topic", "entity_refs", "confidence"],
        properties: {
          index: { type: "integer" },
          keep: { type: "boolean" },
          kind: { type: "string", enum: ["task", "decision", "fact", "idea", "open_question", "pitch_feedback"] },
          authority: { type: "string", enum: ["binding", "stated", "tentative"] },
          action: { type: "string", enum: ["new", "duplicate_of", "updates", "contradicts"] },
          target_id: { type: "string" },
          topic: { type: "string" },
          entity_refs: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
      },
    },
  },
};

const VALIDATE_SYSTEM = `You maintain Sophie's shared memory across her modes (talk, chat, brainstorm, sales pitch, meeting) for ONE user.
You get CANDIDATES from a session that just ended, each with up to 5 EXISTING similar memory items (with id, kind, authority, mode, date).
Return one entry per candidate (same index). Never rewrite candidate text.

keep: false if the candidate is trivial, not understandable on its own, or not about the user's life/work (e.g. "continue later", small talk). Otherwise true.
kind: task (something someone will do) | decision (something decided) | fact (something stated as true) | idea | open_question | pitch_feedback. Use the suggested kind unless clearly wrong.
authority — how binding the content is:
  binding  = explicitly decided, agreed or committed to (meeting decisions, "I will send it on Friday").
  stated   = asserted by the user as fact or plan, but not a formal decision.
  tentative = idea, suggestion, option, hypothesis, something discussed but not decided.
  Brainstorm ideas are tentative unless the user explicitly decided. When in doubt, choose the WEAKER authority.
action — compare ONLY with that candidate's EXISTING items:
  new          = no existing item is about the same specific thing.
  duplicate_of = an existing item says the same thing; the candidate adds nothing.
  updates      = same specific subject, the candidate is newer or more specific (e.g. new deadline, refined plan).
  contradicts  = same specific subject, incompatible content (e.g. "20% discount" vs "max. 10% discount").
  Similar topic is NOT enough — it must be the same specific thing. If unsure, choose new.
target_id: the existing item's id for duplicate_of/updates/contradicts, otherwise "".
topic: 3-8 words naming the subject, in the candidate's language.
entity_refs: people, companies, products or projects explicitly named in the candidate (lowercase, max 5). Never invent.
confidence: 0-1, how sure you are about action and authority.`;

async function validateCandidates({ mode, sessionDate, candidates, neighbors, userId }) {
  const blocks = candidates.map((c, i) => {
    const ex = (neighbors[i] || []).map((n) =>
      `    - id=${n.id} | ${n.kind} | ${n.authority} | ${n.source_mode} | ${n.status === "new" ? "same session" : String(n.created_at).slice(0, 10)} | ${n.status}: ${clip(n.text, 300)}`
    ).join("\n");
    return `[${i}] suggested kind=${c.kind}, hint=${c.authorityHint}: ${clip(c.text, 600)}\n  EXISTING:\n${ex || "    (none)"}`;
  }).join("\n\n");
  const res = await callJson({
    system: VALIDATE_SYSTEM,
    user: `Session mode: ${mode} | Date: ${sessionDate || "unknown"}\n\nCANDIDATES:\n${blocks}`,
    schemaName: "knowledge_validation",
    schema: VALIDATE_SCHEMA,
    userId,
    reason: "knowledge-validate",
    maxTokens: 3000,
  });
  const byIndex = new Map();
  for (const it of res?.items || []) if (Number.isInteger(it.index)) byIndex.set(it.index, it);
  return byIndex;
}

// ---------------------------------------------------------
// Ingest — gathers all sources of a session and writes items
// ---------------------------------------------------------
/**
 * @param {Object} p
 * @param {import('@supabase/supabase-js').SupabaseClient} p.supabase  service-role client
 * @param {string} p.sessionId   user_sessions.id
 * @param {string} p.userId      verified owner
 * @param {string} [p.transcriptText]     for brainstorm idea extraction
 * @param {Object} [p.meetingStructured]  meeting JSON when no meetings row exists (talk-page meetings)
 * @param {string} [p.channel]   "chat" for text chat
 * @param {"ai_extraction"|"backfill"} [p.actor]
 */
export async function ingestSessionKnowledge({ supabase, sessionId, userId, transcriptText = "", meetingStructured = null, channel = null, actor = "ai_extraction" }) {
  const t0 = Date.now();
  if (!supabase || !sessionId || !userId) return { ok: false, error: "missing params" };

  // Session row = truth for owner + mode (never trust the caller for xi isolation)
  const { data: sess, error: sessErr } = await supabase
    .from("user_sessions")
    .select("id, user_id, session_mode, session_type, session_date, title")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessErr) return { ok: false, error: `session: ${sessErr.message}` };
  if (!sess || sess.user_id !== userId) return { ok: false, error: "session not found" };
  const mode = knowledgeModeFor({ sessionMode: sess.session_mode, sessionType: sess.session_type, channel });
  if (!mode || !KNOWLEDGE_MODES.has(mode)) return { ok: true, skipped: "mode_excluded" };

  // Schema probe (tolerate missing migration)
  const probe = await supabase.from("sophie_knowledge_items").select("id").limit(1);
  if (probe.error) {
    if (isMissingSchema(probe.error)) return { ok: true, skipped: "no_schema" };
    return { ok: false, error: `probe: ${probe.error.message}` };
  }

  // ---- Gather sources ----
  const [outRes, stmRes, mtgRes, pitchRes] = await Promise.all([
    supabase.from("conversation_outputs").select("title, recap_text").eq("session_id", sessionId).maybeSingle(),
    supabase.from("sophie_short_term_memory").select("id, open_topics, pending_decisions, next_steps").eq("conversation_id", sessionId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    mode === "meeting" ? supabase.from("meetings").select("id").eq("session_id", sessionId).maybeSingle() : Promise.resolve({ data: null }),
    mode === "sales_pitch" ? supabase.from("sophie_pitch_memory").select("id, topic, target_audience, score, version, parent_pitch_id, strengths, weaknesses").eq("conversation_id", sessionId).order("created_at", { ascending: false }).limit(1).maybeSingle() : Promise.resolve({ data: null }),
  ]);

  let meeting = meetingStructured;
  if (mode === "meeting" && mtgRes?.data?.id) {
    const { data: ms } = await supabase.from("meeting_summary").select("decisions, action_items, open_points").eq("meeting_id", mtgRes.data.id).maybeSingle();
    if (ms && ((ms.decisions || []).length || (ms.action_items || []).length || (ms.open_points || []).length)) meeting = ms;
  }

  let ideas = [];
  if (mode === "brainstorm" && transcriptText) {
    try { ideas = await extractBrainstormIdeas(transcriptText, userId); }
    catch (e) { console.warn("[knowledge] idea extraction failed:", e?.message); }
  }

  const candidates = [
    ...candidatesFromMeeting(sessionId, meeting),
    ...candidateFromPitch(pitchRes?.data, sess.title),
    ...candidatesFromIdeas(sessionId, ideas),
    ...candidatesFromStm(sessionId, stmRes?.data),
  ].slice(0, MAX_CANDIDATES);

  const recapText = clip(outRes?.data?.recap_text);
  const recap = recapText ? {
    kind: "session_recap", authority: "stated", text: recapText, topic: clip(sess.title || outRes?.data?.title, 120) || null,
    idem_key: `recap:${sessionId}`, source_ref: { table: "conversation_outputs", session_id: sessionId, field: "recap_text" },
  } : null;

  if (!candidates.length && !recap) return { ok: true, skipped: "no_sources" };

  // ---- Idempotency: skip candidates already ingested (as item or merged alias) ----
  const keys = [...candidates.map((c) => c.idem_key), ...(recap ? [recap.idem_key] : [])];
  const [byKey, byAlias] = await Promise.all([
    supabase.from("sophie_knowledge_items").select("id, idem_key, alias_keys, text").eq("user_id", userId).in("idem_key", keys),
    supabase.from("sophie_knowledge_items").select("id, idem_key, alias_keys, text").eq("user_id", userId).overlaps("alias_keys", keys),
  ]);
  const exErr = byKey.error || byAlias.error;
  if (exErr) return { ok: false, error: `existing: ${exErr.message}` };
  const existingRows = [...(byKey.data || []), ...(byAlias.data || [])];
  const seen = new Set();
  const recapRow = (existingRows || []).find((r) => r.idem_key === recap?.idem_key) || null;
  for (const r of existingRows || []) { seen.add(r.idem_key); (r.alias_keys || []).forEach((a) => seen.add(a)); }
  const fresh = candidates.filter((c) => !seen.has(c.idem_key));
  const needRecap = recap && (!recapRow || recapRow.text !== recap.text);

  if (!fresh.length && !needRecap) return { ok: true, skipped: "already_ingested" };

  // ---- Embeddings (one batch) ----
  const embedInputs = [...fresh.map((c) => c.text), ...(needRecap ? [recap.text] : [])];
  const vecs = await embedTexts(embedInputs, userId);
  const recapVec = needRecap ? vecs[vecs.length - 1] : null;

  const stats = { mode, created: 0, merged: 0, superseded: 0, conflicts: 0, dropped: 0, recap: false };
  const sessionDate = String(sess.session_date || "").slice(0, 10);

  // ---- Session recap (no validation, upsert by key) ----
  if (needRecap) {
    if (recapRow) {
      await supabase.from("sophie_knowledge_items")
        .update({ text: recap.text, topic: recap.topic, embedding: recapVec, updated_at: new Date().toISOString() })
        .eq("id", recapRow.id);
    } else {
      const { data: ins, error } = await supabase.from("sophie_knowledge_items").insert({
        user_id: userId, source_mode: mode, kind: "session_recap", authority: "stated", text: recap.text, topic: recap.topic,
        idem_key: recap.idem_key, source_ref: recap.source_ref, embedding: recapVec, confidence: 1,
      }).select("id").single();
      if (error) console.warn("[knowledge] recap insert failed:", error.message);
      else {
        await supabase.from("sophie_knowledge_sources").upsert({ item_id: ins.id, session_id: sessionId, user_id: userId }, { onConflict: "item_id,session_id", ignoreDuplicates: true });
        await supabase.from("sophie_knowledge_events").insert({ item_id: ins.id, user_id: userId, event: "created", actor, session_id: sessionId, new: { kind: "session_recap", mode } });
        stats.recap = true;
      }
    }
  }

  if (!fresh.length) return { ok: true, ...stats, ms: Date.now() - t0 };

  // ---- Neighbors per candidate (exact search per user) ----
  const neighbors = await Promise.all(fresh.map(async (c, i) => {
    if (!vecs[i]) return [];
    const { data, error } = await supabase.rpc("match_knowledge", { p_user_id: userId, p_embedding: vecs[i], p_limit: NEIGHBORS });
    if (error) { console.warn("[knowledge] match_knowledge failed:", error.message); return []; }
    return data || [];
  }));

  // ---- Same-session neighbors ----
  // DB neighbors only know items from EARLIER sessions. Candidates of this session
  // (e.g. brainstorm idea "work out everyday scenarios" + next step "work out everyday
  // scenarios") must be compared with each other too. Earlier candidates get the
  // pseudo id "cand:<j>" and are resolved to their real item id while applying.
  const dot = (a, b) => { let d = 0; for (let k = 0; k < a.length; k++) d += a[k] * b[k]; return d; };
  fresh.forEach((c, i) => {
    if (!vecs[i]) return;
    const same = [];
    for (let j = 0; j < i; j++) {
      if (!vecs[j]) continue;
      const sim = dot(vecs[i], vecs[j]); // OpenAI embeddings are unit length → dot = cosine
      if (sim >= SAME_SESSION_SIM) same.push({ id: `cand:${j}`, kind: fresh[j].kind, authority: fresh[j].authorityHint, source_mode: mode, created_at: "this session", status: "new", text: fresh[j].text, similarity: sim });
    }
    same.sort((x, y) => y.similarity - x.similarity);
    neighbors[i] = [...same.slice(0, 3), ...(neighbors[i] || [])].slice(0, NEIGHBORS + 3);
  });

  // ---- Validation ----
  let verdicts;
  try {
    verdicts = await validateCandidates({ mode, sessionDate, candidates: fresh, neighbors, userId });
  } catch (e) {
    // Without validation nothing is merged or superseded — safest fallback is "new" with the hint authority.
    console.warn("[knowledge] validation failed, inserting as new:", e?.message);
    verdicts = new Map();
  }

  // ---- Apply ----
  const applied = new Map(); // candidate index → { id, authority } of the item it ended up in
  for (let i = 0; i < fresh.length; i++) {
    const c = fresh[i];
    const v = verdicts.get(i) || { keep: true, kind: c.kind, authority: c.authorityHint, action: "new", target_id: "", topic: c.topic || "", entity_refs: [], confidence: 0.5 };
    if (!v.keep) { stats.dropped++; continue; }

    const neighborIds = new Map((neighbors[i] || []).map((n) => [n.id, n]));
    let target = v.target_id && neighborIds.has(v.target_id) ? neighborIds.get(v.target_id) : null;
    if (target && String(target.id).startsWith("cand:")) {
      const ref = applied.get(Number(String(target.id).slice(5)));
      target = ref ? { ...target, id: ref.id, authority: ref.authority, status: "open" } : null; // dropped candidate → treat as new
    }
    const confident = Number(v.confidence) >= MIN_MERGE_CONFIDENCE;
    const kind = c.kind === "pitch_feedback" ? "pitch_feedback" : v.kind;
    const authority = AUTHORITY_RANK[v.authority] ? v.authority : c.authorityHint;
    const entities = [...new Set((v.entity_refs || []).map((e) => clip(e, 80).toLowerCase()).filter(Boolean))].slice(0, 5);

    // Duplicate → attach source + alias to existing item, no new row
    if (v.action === "duplicate_of" && target && confident) {
      const { data: tRow } = await supabase.from("sophie_knowledge_items").select("alias_keys").eq("id", target.id).maybeSingle();
      await supabase.from("sophie_knowledge_items")
        .update({ alias_keys: [...new Set([...(tRow?.alias_keys || []), c.idem_key])], updated_at: new Date().toISOString() })
        .eq("id", target.id);
      await supabase.from("sophie_knowledge_sources").upsert({ item_id: target.id, session_id: sessionId, user_id: userId }, { onConflict: "item_id,session_id", ignoreDuplicates: true });
      await supabase.from("sophie_knowledge_events").insert({ item_id: target.id, user_id: userId, event: "merged", actor, session_id: sessionId, evidence: clip(c.text, 500), new: { idem_key: c.idem_key, mode } });
      applied.set(i, { id: target.id, authority: target.authority });
      stats.merged++;
      continue;
    }

    const supersedes = target && confident && (v.action === "updates" || v.action === "contradicts") &&
      (AUTHORITY_RANK[authority] || 0) >= (AUTHORITY_RANK[target.authority] || 0);
    const detail = { ...(c.detail || {}) };
    if (target && confident && !supersedes && v.action === "contradicts") { detail.conflict_with = target.id; stats.conflicts++; }
    if (target && confident && !supersedes && v.action === "updates") detail.related_to = target.id;

    const { data: ins, error: insErr } = await supabase.from("sophie_knowledge_items").insert({
      user_id: userId, source_mode: mode, kind, authority, text: c.text,
      topic: clip(v.topic || c.topic, 120) || null, detail, entity_refs: entities,
      confidence: Math.max(0, Math.min(1, Number(v.confidence) || 0.5)),
      source_ref: c.source_ref || {}, idem_key: c.idem_key, embedding: vecs[i],
    }).select("id").single();
    if (insErr) {
      if (insErr.code !== "23505") console.warn("[knowledge] insert failed:", insErr.message); // 23505 = parallel run won
      continue;
    }
    stats.created++;
    applied.set(i, { id: ins.id, authority });
    await supabase.from("sophie_knowledge_sources").upsert({ item_id: ins.id, session_id: sessionId, user_id: userId }, { onConflict: "item_id,session_id", ignoreDuplicates: true });
    await supabase.from("sophie_knowledge_events").insert({ item_id: ins.id, user_id: userId, event: "created", actor, session_id: sessionId, new: { kind, authority, mode } });

    if (supersedes) {
      const nowIso = new Date().toISOString();
      const { error: supErr } = await supabase.from("sophie_knowledge_items")
        .update({ status: "superseded", superseded_by_id: ins.id, status_changed_at: nowIso, updated_at: nowIso })
        .eq("id", target.id)
        .in("status", ["open", "done"]);
      if (!supErr) {
        stats.superseded++;
        await supabase.from("sophie_knowledge_events").insert({
          item_id: target.id, user_id: userId, event: "superseded", actor, session_id: sessionId,
          old: { status: target.status, authority: target.authority }, new: { status: "superseded", by: ins.id, reason: v.action },
          evidence: clip(c.text, 500),
        });
      }
    }
  }

  stats.ms = Date.now() - t0;
  console.log("[knowledge] ingested", { session: sessionId.slice(0, 8), user: userId.slice(0, 8), ...stats });
  return { ok: true, ...stats };
}

// =========================================================
// READ SIDE (Phase 4) — stable cross-mode block for the system prompt
// =========================================================
// Built once at session start (prompt-cache friendly), never refreshed mid-session.
// Behind an allowlist until the quality gate is passed: KNOWLEDGE_READ=all opens it
// for everyone, KNOWLEDGE_READ_EMAILS (comma list) adds testers.

const KNOWLEDGE_READ_DEFAULT_EMAILS = ["michael@mmhammer.org"];

export function knowledgeReadEnabled(user) {
  if (String(process.env.KNOWLEDGE_READ || "").toLowerCase() === "all") return true;
  const extra = String(process.env.KNOWLEDGE_READ_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const email = String(user?.email || "").toLowerCase();
  return !!email && [...KNOWLEDGE_READ_DEFAULT_EMAILS, ...extra].includes(email);
}

const BLOCK_BUDGET = { talk: 1100, chat: 1100, meeting: 1700, brainstorm: 1700, sales_pitch: 1700 };
const KIND_LABEL = { task: "task", decision: "decision", idea: "idea", open_question: "open question", pitch_feedback: "pitch result", fact: "fact" };
const AUTHORITY_LABEL = { binding: "decided", stated: "stated", tentative: "NOT decided" };
const MODE_LABEL = { talk: "talk", chat: "chat", brainstorm: "brainstorm", sales_pitch: "sales pitch", meeting: "meeting" };

function renderItem(k) {
  const date = String(k.created_at || "").slice(0, 10);
  const tags = [KIND_LABEL[k.kind] || k.kind, MODE_LABEL[k.source_mode] || k.source_mode, date, AUTHORITY_LABEL[k.authority] || k.authority];
  const d = k.detail || {};
  const extras = [];
  if (d.owner) extras.push(`owner: ${clip(d.owner, 40)}`);
  if (d.due) extras.push(`due: ${clip(d.due, 30)}`);
  if (d.favorite) extras.push("user's favorite");
  if (d.conflict_with) extras.push("conflicts with an earlier decision");
  if (k.suggested_status === "done") extras.push("possibly done already — ask briefly before relying on it");
  return `- [${tags.join(" · ")}] ${clip(k.text, 220)}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

function pickForBlock(items, relevant, mode) {
  const used = new Set();
  const take = (list, n) => list.filter((k) => !used.has(k.id)).slice(0, n).map((k) => { used.add(k.id); return k; });
  const byKind = (kind) => items.filter((k) => k.kind === kind);
  const fortnight = Date.now() - 14 * 86400000;
  const isTopicMode = mode === "meeting" || mode === "brainstorm" || mode === "sales_pitch";
  return [
    ...take(relevant, isTopicMode ? 6 : 0),
    ...take(byKind("task"), isTopicMode ? 3 : 5),
    ...take(byKind("decision").filter((k) => k.authority === "binding" && new Date(k.created_at).getTime() >= fortnight), 3),
    ...take([...byKind("idea")].sort((a, b) => (b.detail?.favorite ? 1 : 0) - (a.detail?.favorite ? 1 : 0)), 3),
    ...take(byKind("pitch_feedback"), 1),
    ...take(byKind("open_question"), 2),
  ];
}

/**
 * @returns {Promise<string|null>} prompt block or null (nothing to say / excluded / no schema)
 */
export async function loadCrossModeBlock({ userId, sessionMode = null, channel = "voice", topic = "" }) {
  const mode = knowledgeModeFor({ sessionMode, channel });
  if (!userId || !mode) return null; // xi → null
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const topicText = clip(topic, 600);
  const wantsTopic = !!topicText && (mode === "meeting" || mode === "brainstorm" || mode === "sales_pitch");

  const [baseRes, relevant] = await Promise.all([
    supabase.from("sophie_knowledge_items")
      .select("id, source_mode, kind, authority, text, detail, suggested_status, created_at")
      .eq("user_id", userId)
      .eq("status", "open")
      .neq("kind", "session_recap")
      .order("created_at", { ascending: false })
      .limit(60),
    (async () => {
      if (!wantsTopic) return [];
      try {
        const [vec] = await embedTexts([topicText], userId);
        const { data, error } = await supabase.rpc("recall_knowledge", { p_user_id: userId, p_query: topicText, p_embedding: vec, p_limit: 10 });
        if (error) return [];
        return (data || []).filter((k) => k.kind !== "session_recap" && k.status === "open");
      } catch { return []; }
    })(),
  ]);
  if (baseRes.error) {
    if (!isMissingSchema(baseRes.error)) console.warn("[knowledge] block load failed:", baseRes.error.message);
    return null;
  }
  return renderCrossModeBlock(baseRes.data || [], relevant, mode);
}

/** Pure: selection + formatting (testable without DB). */
export function renderCrossModeBlock(items, relevant, mode) {
  if (!items?.length && !relevant?.length) return null;
  const budget = BLOCK_BUDGET[mode] || 1100;
  const lines = [];
  let used = 0;
  for (const k of pickForBlock(items || [], relevant || [], mode)) {
    const line = renderItem(k);
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return null;
  return `${CROSS_MODE_HEADER}
${lines.join("\n")}

${CROSS_MODE_RULES}`;
}

// Prompt text — English (project rule). Wording approved by Michael before activation.
const CROSS_MODE_HEADER = `SHARED MEMORY ACROSS MODES
What you know from the user's other sessions (talk, chat, brainstorm, sales pitch, meeting). Each line: [type · mode · date · how binding].`;

const CROSS_MODE_RULES = `RULES FOR SHARED MEMORY:
- Use it when the conversation touches the topic. You may bring up ONE matching open task, recent decision or idea naturally — at most once per topic. Never list these items and never recap the past unprompted.
- "NOT decided" items are ideas, options or open questions. Never present them as decisions or facts.
- If items contradict each other, the most recent decided one is valid.
- Never claim anything about earlier sessions that is not in your memory. If you are unsure, say so instead of guessing.`;
