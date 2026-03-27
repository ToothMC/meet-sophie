// api/meeting.js — Meeting Mode Endpoint
// ?action=create    — Neues Meeting erstellen (phase=prep)
// ?action=get       — Meeting + Context + Notes laden
// ?action=list      — Meeting-Historie (letzte 20)
// ?action=phase     — Phase wechseln (prep→live→post→closed)
// ?action=context   — Kontext hinzufügen (Agenda, Teilnehmer, Ziel, Text)
// ?action=note      — Note speichern (decision, action, risk, open_point)
// ?action=message   — Chat-Nachricht im Meeting (phasenspezifisch)
// ?action=summarize — Summary generieren (POST-Phase)
// ?action=summary   — Summary abrufen

import { createClient } from "@supabase/supabase-js";
import { buildSophiePrompt, mapPlanToTier } from "../lib/sophie-core.js";
import mammoth from "mammoth";

// ---------------------------------------------------------------------------
// Auth helpers (shared with chat.js)
// ---------------------------------------------------------------------------

function getToken(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

async function getAuthenticatedUser(token, supabaseUrl, serviceKey) {
  if (!token) return null;
  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

function envCheck(res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    return res.status(500).json({ error: "Missing Supabase env vars" });
  if (!process.env.OPENAI_API_KEY)
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  return null;
}

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  return body && typeof body === "object" ? body : {};
}

async function requireAuth(req, res) {
  const token = getToken(req);
  const user = await getAuthenticatedUser(token, process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!user) { res.status(401).json({ error: "Authentication required" }); return null; }
  return user;
}

// ---------------------------------------------------------------------------
// File content extraction (server-side)
// ---------------------------------------------------------------------------

async function extractFileContent(supabase, filePath) {
  // Download file from Supabase Storage
  const { data: fileData, error: dlError } = await supabase.storage
    .from("meeting-files")
    .download(filePath);
  if (dlError || !fileData) return null;

  const fileName = filePath.split("/").pop().replace(/^\d+_/, "");
  const ext = fileName.split(".").pop().toLowerCase();

  // TXT: read directly
  if (ext === "txt") {
    const text = await fileData.text();
    return text.length > 8000 ? text.slice(0, 8000) + "\n... (truncated)" : text;
  }

  // PDF / DOCX / PPTX / Images: use OpenAI to extract/describe content
  if (["pdf", "docx", "pptx", "png", "jpg", "jpeg", "webp"].includes(ext)) {
    const isImage = ["png", "jpg", "jpeg", "webp"].includes(ext);

    // Convert to base64 for images
    if (isImage) {
      const buffer = await fileData.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;

      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 1500,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: `Describe and extract all text from this image (${fileName}). Be thorough. If it contains a document, table, or chart, extract the data.` },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
            ],
          }],
        }),
      });

      if (resp.ok) {
        const data = await resp.json();
        return `[Image: ${fileName}]\n${data?.choices?.[0]?.message?.content || ""}`;
      }
    }

    // DOCX: extract with mammoth
    if (ext === "docx") {
      try {
        const buffer = Buffer.from(await fileData.arrayBuffer());
        const result = await mammoth.extractRawText({ buffer });
        const text = (result.value || "").trim();
        if (text) {
          return `[DOCX: ${fileName}]\n${text.length > 8000 ? text.slice(0, 8000) + "\n... (truncated)" : text}`;
        }
      } catch (e) {
        console.error("DOCX extraction error:", e?.message);
      }
      return `[DOCX: ${fileName}] — Could not extract text.`;
    }

    // PDF: extract readable strings from raw binary
    if (ext === "pdf") {
      const buffer = await fileData.arrayBuffer();
      const textContent = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
      const readable = textContent.match(/\(([^)]+)\)/g);
      if (readable && readable.length > 5) {
        const extracted = readable.map(s => s.slice(1, -1)).join(" ").slice(0, 8000);
        return `[PDF: ${fileName}]\n${extracted}`;
      }
      return `[PDF: ${fileName}] — Text extraction limited. Content stored as reference.`;
    }

    // PPTX: basic reference (full extraction would need separate library)
    if (ext === "pptx") {
      return `[PPTX: ${fileName}] — Presentation uploaded for reference.`;
    }

    return `[Document: ${fileName}] — Uploaded for reference.`;
  }

  return `[File: ${fileName}]`;
}

// Phase transition validation
const VALID_TRANSITIONS = {
  prep: ["live"],
  live: ["post"],
  post: ["closed"],
  closed: [],
};

// ---------------------------------------------------------------------------
// Action: create — Neues Meeting erstellen
// ---------------------------------------------------------------------------

async function handleCreate(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await requireAuth(req, res);
  if (!user) return;

  const body = parseBody(req);
  const meetingType = ["team", "client", "strategy", "other"].includes(body.meeting_type) ? body.meeting_type : "other";
  const sophieRole = ["prepare", "co-think", "document"].includes(body.sophie_role) ? body.sophie_role : "co-think";
  const title = (body.title || "").trim() || null;
  const parentMeetingId = (body.parent_meeting_id || "").trim() || null;

  const supabase = getSupabase();

  // Validate parent_meeting_id if provided
  if (parentMeetingId) {
    const { data: parent } = await supabase
      .from("meetings")
      .select("id")
      .eq("id", parentMeetingId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!parent) return res.status(400).json({ error: "Parent meeting not found" });
  }

  const { data, error } = await supabase
    .from("meetings")
    .insert({
      user_id: user.id,
      title,
      meeting_type: meetingType,
      phase: "prep",
      sophie_role: sophieRole,
      parent_meeting_id: parentMeetingId,
    })
    .select("id, phase, meeting_type, sophie_role, parent_meeting_id, created_at")
    .single();

  if (error) {
    console.error("Meeting create error:", error);
    return res.status(500).json({ error: "Failed to create meeting" });
  }

  return res.status(200).json({ ok: true, meeting: data });
}

// ---------------------------------------------------------------------------
// Action: get — Meeting + Context + Notes laden
// ---------------------------------------------------------------------------

async function handleGet(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "Missing meeting id" });

  const supabase = getSupabase();

  const [meetingRes, contextRes, notesRes, summaryRes] = await Promise.all([
    supabase.from("meetings").select("*").eq("id", id).eq("user_id", user.id).maybeSingle(),
    supabase.from("meeting_context").select("*").eq("meeting_id", id).order("created_at", { ascending: true }),
    supabase.from("meeting_notes").select("*").eq("meeting_id", id).order("created_at", { ascending: true }),
    supabase.from("meeting_summary").select("*").eq("meeting_id", id).maybeSingle(),
  ]);

  if (!meetingRes.data) return res.status(404).json({ error: "Meeting not found" });

  return res.status(200).json({
    ok: true,
    meeting: meetingRes.data,
    context: contextRes.data || [],
    notes: notesRes.data || [],
    summary: summaryRes.data || null,
  });
}

// ---------------------------------------------------------------------------
// Action: list — Meeting-Historie
// ---------------------------------------------------------------------------

async function handleList(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("meetings")
    .select("id, title, meeting_type, phase, sophie_role, started_at, ended_at, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("Meeting list error:", error);
    return res.status(500).json({ error: "Failed to list meetings" });
  }

  return res.status(200).json({ ok: true, meetings: data || [] });
}

// ---------------------------------------------------------------------------
// Action: phase — Phase wechseln
// ---------------------------------------------------------------------------

async function handlePhase(req, res) {
  if (req.method !== "POST" && req.method !== "PATCH") return res.status(405).json({ error: "Method not allowed" });

  const user = await requireAuth(req, res);
  if (!user) return;

  const body = parseBody(req);
  const { meeting_id, phase } = body;
  if (!meeting_id || !phase) return res.status(400).json({ error: "Missing meeting_id or phase" });

  const supabase = getSupabase();

  // Load current meeting
  const { data: meeting } = await supabase
    .from("meetings")
    .select("id, phase")
    .eq("id", meeting_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!meeting) return res.status(404).json({ error: "Meeting not found" });

  // Validate transition
  const allowed = VALID_TRANSITIONS[meeting.phase] || [];
  if (!allowed.includes(phase)) {
    return res.status(400).json({ error: `Invalid transition: ${meeting.phase} → ${phase}`, allowed });
  }

  // Build update
  const update = { phase };
  if (phase === "live") update.started_at = new Date().toISOString();
  if (phase === "post") update.ended_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("meetings")
    .update(update)
    .eq("id", meeting_id)
    .select("id, phase, started_at, ended_at")
    .single();

  if (error) {
    console.error("Phase update error:", error);
    return res.status(500).json({ error: "Failed to update phase" });
  }

  return res.status(200).json({ ok: true, meeting: data });
}

// ---------------------------------------------------------------------------
// Action: context — Kontext hinzufügen
// ---------------------------------------------------------------------------

async function handleContext(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await requireAuth(req, res);
  if (!user) return;

  const body = parseBody(req);
  const { meeting_id, context_type, content } = body;
  if (!meeting_id || !context_type || !content) {
    return res.status(400).json({ error: "Missing meeting_id, context_type, or content" });
  }

  if (!["agenda", "participants", "goal", "text_note", "file", "history_ref"].includes(context_type)) {
    return res.status(400).json({ error: "Invalid context_type" });
  }

  const supabase = getSupabase();

  // Verify meeting ownership
  const { data: meeting } = await supabase
    .from("meetings")
    .select("id")
    .eq("id", meeting_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!meeting) return res.status(404).json({ error: "Meeting not found" });

  let finalContent = content.trim();

  // For file uploads: extract text content server-side if not already extracted
  if (context_type === "file" && body.file_path && finalContent.startsWith("[File:")) {
    try {
      const extracted = await extractFileContent(supabase, body.file_path);
      if (extracted) finalContent = extracted;
    } catch (e) {
      console.error("File extraction error:", e?.message);
      // Keep original placeholder content
    }
  }

  const insertData = { meeting_id, context_type, content: finalContent };
  if (body.file_path) insertData.file_path = body.file_path;

  const { data, error } = await supabase
    .from("meeting_context")
    .insert(insertData)
    .select("id, context_type, file_path, created_at")
    .single();

  if (error) {
    console.error("Context insert error:", error);
    return res.status(500).json({ error: "Failed to add context" });
  }

  return res.status(200).json({ ok: true, context: data });
}

// ---------------------------------------------------------------------------
// Action: note — Note speichern
// ---------------------------------------------------------------------------

async function handleNote(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await requireAuth(req, res);
  if (!user) return;

  const body = parseBody(req);
  const { meeting_id, note_type, content } = body;
  if (!meeting_id || !note_type || !content) {
    return res.status(400).json({ error: "Missing meeting_id, note_type, or content" });
  }

  if (!["note", "decision", "action", "risk", "open_point"].includes(note_type)) {
    return res.status(400).json({ error: "Invalid note_type" });
  }

  const supabase = getSupabase();

  const { data: meeting } = await supabase
    .from("meetings")
    .select("id")
    .eq("id", meeting_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!meeting) return res.status(404).json({ error: "Meeting not found" });

  const { data, error } = await supabase
    .from("meeting_notes")
    .insert({ meeting_id, note_type, content: content.trim() })
    .select("id, note_type, created_at")
    .single();

  if (error) {
    console.error("Note insert error:", error);
    return res.status(500).json({ error: "Failed to add note" });
  }

  return res.status(200).json({ ok: true, note: data });
}

// ---------------------------------------------------------------------------
// Action: message — Chat-Nachricht im Meeting (phasenspezifisch)
// ---------------------------------------------------------------------------

async function handleMessage(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const err = envCheck(res);
  if (err) return;

  const user = await requireAuth(req, res);
  if (!user) return;

  const body = parseBody(req);
  const { meeting_id, messages } = body;
  if (!meeting_id) return res.status(400).json({ error: "Missing meeting_id" });
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "Missing messages" });

  const supabase = getSupabase();

  // Load meeting + context + notes
  const [meetingRes, contextRes, notesRes] = await Promise.all([
    supabase.from("meetings").select("*").eq("id", meeting_id).eq("user_id", user.id).maybeSingle(),
    supabase.from("meeting_context").select("context_type, content").eq("meeting_id", meeting_id).order("created_at"),
    supabase.from("meeting_notes").select("note_type, content").eq("meeting_id", meeting_id).order("created_at"),
  ]);

  const meeting = meetingRes.data;
  if (!meeting) return res.status(404).json({ error: "Meeting not found" });

  // Load user profile for tier/prompt
  const [profRes, subRes] = await Promise.all([
    supabase.from("user_profile").select("first_name,preferred_name,preferred_addressing,preferred_pronoun,preferred_language,occupation,conversation_style").eq("user_id", user.id).maybeSingle(),
    supabase.from("user_subscriptions").select("is_active,status,plan").eq("user_id", user.id).maybeSingle(),
  ]);

  const profile = profRes.data || {};
  const isPremium = !!(subRes.data?.is_active || subRes.data?.status === "active");
  const plan = subRes.data?.plan || null;
  const tier = mapPlanToTier(plan, isPremium);

  const language = (profile.preferred_language || "en").toLowerCase().trim();

  // Build meeting context string
  const contextItems = (contextRes.data || []).map(c => `[${c.context_type.toUpperCase()}] ${c.content}`).join("\n");
  const noteItems = (notesRes.data || []).map(n => `[${n.note_type.toUpperCase()}] ${n.content}`).join("\n");

  // Load parent meeting history context if linked
  let historyBlock = null;
  if (meeting.parent_meeting_id) {
    const { data: parentSummary } = await supabase
      .from("meeting_summary")
      .select("short_summary, action_items, open_points, decisions")
      .eq("meeting_id", meeting.parent_meeting_id)
      .maybeSingle();
    if (parentSummary) {
      const openActions = (parentSummary.action_items || [])
        .filter(a => !a.done)
        .map(a => `- ${typeof a === "string" ? a : a.text || JSON.stringify(a)}`)
        .join("\n");
      const openPts = (parentSummary.open_points || [])
        .map(p => `- ${typeof p === "string" ? p : p.text || JSON.stringify(p)}`)
        .join("\n");
      historyBlock = [
        "--- PREVIOUS MEETING ---",
        parentSummary.short_summary ? `Summary: ${parentSummary.short_summary}` : null,
        openActions ? `Open Action Items:\n${openActions}` : null,
        openPts ? `Open Points:\n${openPts}` : null,
        "--- END PREVIOUS MEETING ---",
      ].filter(Boolean).join("\n");
    }
  }

  const meetingContext = [
    meeting.title ? `Meeting: ${meeting.title}` : null,
    `Typ: ${meeting.meeting_type}`,
    `Phase: ${meeting.phase}`,
    `Sophie-Rolle: ${meeting.sophie_role}`,
    contextItems ? `\nKONTEXT:\n${contextItems}` : null,
    noteItems ? `\nBISHERIGE NOTIZEN:\n${noteItems}` : null,
    historyBlock ? `\n${historyBlock}` : null,
  ].filter(Boolean).join("\n");

  // Build system prompt with meeting-specific phase prompt
  const systemPrompt = buildSophiePrompt({
    tier,
    sessionMode: "meeting",
    meetingPhase: meeting.phase,
    meetingContext,
    language,
    user: {
      name: (profile.preferred_name || profile.first_name || "").trim(),
      addressing: profile.preferred_addressing,
      pronoun: profile.preferred_pronoun,
      occupation: profile.occupation,
      conversationStyle: profile.conversation_style,
    },
    memory: {},
    channel: "chat",
  });

  // Call OpenAI
  const openaiModel = process.env.OPENAI_CHAT_MODEL || "gpt-4o";
  const openaiMessages = [
    { role: "system", content: systemPrompt },
    ...messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: String(m.content || "").slice(0, 4000) })),
  ];

  let openaiResp;
  try {
    openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: openaiModel,
        max_tokens: 1024,
        messages: openaiMessages,
        temperature: 0.7,
      }),
    });
  } catch (e) {
    console.error("OpenAI API fetch error:", e?.message);
    return res.status(502).json({ error: "OpenAI API unavailable" });
  }

  if (!openaiResp.ok) {
    const errText = await openaiResp.text().catch(() => "");
    console.error("OpenAI API error:", openaiResp.status, errText.slice(0, 200));
    return res.status(openaiResp.status).json({ error: "OpenAI API error" });
  }

  const openaiData = await openaiResp.json();
  const rawReply = openaiData?.choices?.[0]?.message?.content || "";
  if (!rawReply) return res.status(502).json({ error: "Empty response from OpenAI" });

  // Extract structured items from LIVE-phase responses
  let extractedItems = null;
  let hintData = null;
  if (meeting.phase === "live") {
    // Extract decisions/actions/risks/open_points JSON
    const jsonMatch = rawReply.match(/\{[\s\S]*"decisions"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        extractedItems = JSON.parse(jsonMatch[0]);
        // Auto-save extracted items as notes
        const noteInserts = [];
        for (const d of (extractedItems.decisions || [])) {
          noteInserts.push({ meeting_id, note_type: "decision", content: typeof d === "string" ? d : d.text || JSON.stringify(d) });
        }
        for (const a of (extractedItems.actions || extractedItems.action_items || [])) {
          noteInserts.push({ meeting_id, note_type: "action", content: typeof a === "string" ? a : a.text || JSON.stringify(a) });
        }
        for (const r of (extractedItems.risks || [])) {
          noteInserts.push({ meeting_id, note_type: "risk", content: typeof r === "string" ? r : r.text || JSON.stringify(r) });
        }
        for (const o of (extractedItems.open_points || [])) {
          noteInserts.push({ meeting_id, note_type: "open_point", content: typeof o === "string" ? o : o.text || JSON.stringify(o) });
        }
        if (noteInserts.length > 0) {
          await supabase.from("meeting_notes").insert(noteInserts);
        }
      } catch { /* JSON parse failed, ignore */ }
    }

    // Extract hint JSON from response (silent hint system)
    const hintMatch = rawReply.match(/\{"hint"\s*:\s*\{[^}]*\}\}/);
    if (hintMatch) {
      try {
        hintData = JSON.parse(hintMatch[0]).hint;
        // Save hint as meeting_note with type 'silent_hint'
        const hintText = rawReply.match(/💡\s*([^\n{]+)/)?.[1]?.trim() || hintData.type;
        await supabase.from("meeting_notes").insert({
          meeting_id,
          note_type: "silent_hint",
          content: JSON.stringify({ type: hintData.type, text: hintText }),
        });
      } catch { /* hint parse failed, ignore */ }
    }
  }

  // Clean reply (strip JSON blocks, mode tokens, keep 💡 hint text visible)
  const reply = rawReply
    .replace(/```json[\s\S]*?```/g, "")
    .replace(/\{[\s\S]*"decisions"[\s\S]*\}/g, "")
    .replace(/\{"hint"\s*:\s*\{[^}]*\}\}/g, "")
    .replace(/\s*\[MODE_DETECTED:\w+\]\s*/g, "")
    .replace(/\s*\[SYSTEM:[^\]]*\]\s*/g, "")
    .replace(/\s*\[SESSION_END\]\s*/g, "")
    .trim() || rawReply.trim();

  // Save user message + Sophie reply as chat_message notes for summary
  const lastUserMsg = messages[messages.length - 1]?.content || "";
  const { error: noteErr } = await supabase.from("meeting_notes").insert([
    { meeting_id, note_type: "chat_message", content: `[User] ${lastUserMsg}` },
    { meeting_id, note_type: "chat_message", content: `[Sophie] ${reply}` },
  ]);
  if (noteErr) console.error("[meeting] note insert failed:", noteErr.message);

  return res.status(200).json({
    ok: true,
    reply,
    phase: meeting.phase,
    extracted_items: extractedItems,
    hint: hintData || null,
    model: openaiModel,
  });
}

// ---------------------------------------------------------------------------
// Action: summarize — Summary generieren (POST-Phase)
// ---------------------------------------------------------------------------

// Summarize meeting + trigger HTML report via 4-AI pipeline
async function handleSummarize(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const err = envCheck(res);
  if (err) return;

  const user = await requireAuth(req, res);
  if (!user) return;

  const body = parseBody(req);
  const { meeting_id } = body;
  if (!meeting_id) return res.status(400).json({ error: "Missing meeting_id" });

  const supabase = getSupabase();

  // Load meeting + all data
  const [meetingRes, contextRes, notesRes] = await Promise.all([
    supabase.from("meetings").select("*").eq("id", meeting_id).eq("user_id", user.id).maybeSingle(),
    supabase.from("meeting_context").select("context_type, content").eq("meeting_id", meeting_id),
    supabase.from("meeting_notes").select("note_type, content, is_confirmed").eq("meeting_id", meeting_id).order("created_at"),
  ]);

  const meeting = meetingRes.data;
  if (!meeting) return res.status(404).json({ error: "Meeting not found" });

  const profile = await supabase.from("user_profile").select("preferred_language").eq("user_id", user.id).maybeSingle();
  const language = (profile.data?.preferred_language || "en").toLowerCase();

  // Build summary prompt
  const contextStr = (contextRes.data || []).map(c => `[${c.context_type}] ${c.content}`).join("\n");
  const notes = (notesRes.data || []).filter(n => n.note_type !== "silent_hint");
  const notesStr = notes.map(n => `[${n.note_type}] ${n.content}`).join("\n");

  // Chat transcript: client-sent transcript (voice or chat-fallback) takes priority over DB
  const clientTranscript = (body.chat_transcript || "").trim();
  let chatTranscript;
  if (clientTranscript) {
    // Client sends voice transcript (preferred) or chat-fallback — always use it when present
    chatTranscript = clientTranscript;
  } else {
    // Fallback: read chat_message notes from DB
    const { data: chatData } = await supabase
      .from("meeting_notes")
      .select("content, created_at")
      .eq("meeting_id", meeting_id)
      .eq("note_type", "chat_message")
      .order("created_at");
    chatTranscript = (chatData || []).map(m => m.content).join("\n").trim();
  }

  console.log(`[meeting-summarize] ${meeting_id}: notes=${notesStr.length}, context=${contextStr.length}, chatDB=${dbTranscript.length}, chatClient=${(body.chat_transcript||"").length}`);

  // If there's no content at all, return empty summary — do NOT hallucinate
  if (!notesStr.trim() && !contextStr.trim() && !chatTranscript.trim()) {
    const emptySummary = {
      meeting_id,
      short_summary: language === "de" ? "Keine Inhalte erfasst." : language === "fr" ? "Aucun contenu enregistré." : "No content captured.",
      decisions: [],
      action_items: [],
      open_points: [],
      risks: [],
    };
    const { data: saved } = await supabase
      .from("meeting_summary")
      .upsert(emptySummary, { onConflict: "meeting_id" })
      .select()
      .single();
    return res.status(200).json({ ok: true, summary: saved || emptySummary });
  }

  const summarySystemPrompt = `You are Sophie. Generate a structured meeting summary.
${language === "de" ? "Antworte auf Deutsch." : language === "fr" ? "Réponds en français." : "Respond in English."}

Meeting: ${meeting.title || "Untitled"}
Type: ${meeting.meeting_type}
${contextStr ? `\nContext:\n${contextStr}` : ""}
${notesStr ? `\nNotes from meeting:\n${notesStr}` : ""}
${chatTranscript ? `\nChat transcript:\n${chatTranscript}` : ""}

CRITICAL RULES:
- ONLY summarize what is EXPLICITLY written in the notes and context above.
- Do NOT invent, assume, or hallucinate any content.
- If a category has no items, return an empty array [].
- If there is very little content, the summary should be very short.
- NEVER make up decisions, action items, or risks that are not explicitly stated.

Generate a JSON object with this exact schema:
{
  "short_summary": "2-3 sentence summary of ONLY what was actually discussed",
  "decisions": [{ "text": "...", "owner": "..." }],
  "action_items": [{ "text": "...", "owner": "...", "due": "..." }],
  "open_points": [{ "text": "..." }],
  "risks": [{ "text": "...", "severity": "low|medium|high" }]
}

Return ONLY the JSON object, no other text.`;

  let openaiResp;
  try {
    openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_CHAT_MODEL || "gpt-4o",
        max_tokens: 1500,
        messages: [{ role: "system", content: summarySystemPrompt }],
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
    });
  } catch (e) {
    console.error("OpenAI API error:", e?.message);
    return res.status(502).json({ error: "OpenAI API unavailable" });
  }

  if (!openaiResp.ok) {
    return res.status(openaiResp.status).json({ error: "OpenAI API error" });
  }

  const data = await openaiResp.json();
  const rawContent = data?.choices?.[0]?.message?.content || "{}";

  let summary;
  try {
    summary = JSON.parse(rawContent);
  } catch {
    return res.status(502).json({ error: "Failed to parse summary JSON" });
  }

  // Generate follow-up diff if parent meeting exists
  let followupDiff = null;
  if (meeting.parent_meeting_id) {
    const { data: parentSummary } = await supabase
      .from("meeting_summary")
      .select("action_items, open_points")
      .eq("meeting_id", meeting.parent_meeting_id)
      .maybeSingle();

    if (parentSummary) {
      const diffPrompt = `You are Sophie. Compare the previous meeting's action items and open points with the current meeting notes.
${language === "de" ? "Antworte auf Deutsch." : language === "fr" ? "Réponds en français." : "Respond in English."}

PREVIOUS MEETING:
Action Items: ${JSON.stringify(parentSummary.action_items || [])}
Open Points: ${JSON.stringify(parentSummary.open_points || [])}

CURRENT MEETING NOTES:
${notesStr}

CURRENT MEETING SUMMARY:
${JSON.stringify(summary)}

Generate a JSON object with this schema:
{
  "resolved": [{ "text": "...", "status": "done" }],
  "still_open": [{ "text": "...", "status": "open" }],
  "escalated": [{ "text": "...", "status": "escalated" }],
  "new_items": [{ "text": "..." }]
}

Rules:
- "resolved": items from the previous meeting that were addressed or completed
- "still_open": items from previous meeting still not resolved
- "escalated": items that got worse or more urgent
- "new_items": completely new action items or points from the current meeting
Return ONLY the JSON object.`;

      try {
        const diffResp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: process.env.OPENAI_CHAT_MODEL || "gpt-4o",
            max_tokens: 1000,
            messages: [{ role: "system", content: diffPrompt }],
            temperature: 0.3,
            response_format: { type: "json_object" },
          }),
        });
        if (diffResp.ok) {
          const diffData = await diffResp.json();
          const diffContent = diffData?.choices?.[0]?.message?.content || "{}";
          followupDiff = JSON.parse(diffContent);
        }
      } catch (e) {
        console.error("Follow-up diff generation error:", e?.message);
        // Non-critical, continue without diff
      }
    }
  }

  // Upsert summary (including followup_diff if generated)
  const upsertData = {
    meeting_id,
    short_summary: summary.short_summary || "",
    decisions: summary.decisions || [],
    action_items: summary.action_items || [],
    open_points: summary.open_points || [],
    risks: summary.risks || [],
  };
  if (followupDiff) upsertData.followup_diff = followupDiff;

  const { data: saved, error: saveErr } = await supabase
    .from("meeting_summary")
    .upsert(upsertData, { onConflict: "meeting_id" })
    .select()
    .single();

  if (saveErr) {
    console.error("Summary save error:", saveErr);
    return res.status(500).json({ error: "Failed to save summary" });
  }

  // Auto-generate title if missing
  if (!meeting.title && summary.short_summary) {
    const autoTitle = summary.short_summary.slice(0, 60).replace(/\.+$/, "").trim();
    await supabase.from("meetings").update({ title: autoTitle }).eq("id", meeting_id);
  }

  // -----------------------------------------------------------------------
  // Trigger HTML Report via generate-report pipeline (same as Talk mode)
  // -----------------------------------------------------------------------
  let reportSessionId = null;
  try {
    // Build FULL transcript (context + notes + chat) for the report pipeline
    const fullTranscriptParts = [];
    if (meeting.title) fullTranscriptParts.push(`Meeting: ${meeting.title}`);
    if (meeting.meeting_type) fullTranscriptParts.push(`Typ: ${meeting.meeting_type}`);
    if (contextStr.trim()) fullTranscriptParts.push(`\nKontext:\n${contextStr}`);
    if (chatTranscript.trim()) fullTranscriptParts.push(`\nGespräch:\n${chatTranscript}`);
    if (notesStr.trim()) fullTranscriptParts.push(`\nNotizen:\n${notesStr}`);
    const fullTranscript = fullTranscriptParts.join("\n");

    if (fullTranscript.trim().length > 50) {
      // Create a user_session so generate-report can link to it
      const { data: session } = await supabase.from("user_sessions").insert({
        user_id: user.id,
        session_mode: "meeting",
        status: "ended",
        title: meeting.title || "Meeting",
      }).select("id").single();

      if (session?.id) {
        reportSessionId = session.id;

        // Link meeting to session
        await supabase.from("meetings").update({ session_id: session.id }).eq("id", meeting_id);

        // Create conversation_outputs row for report tracking
        await supabase.from("conversation_outputs").upsert({
          session_id: session.id,
          report_status: "pending",
          report_progress: 0,
        }, { onConflict: "session_id" });

        console.log(`[meeting-summarize] report session created: ${session.id}, frontend will trigger generate-report`);
      }
    }
  } catch (e) {
    console.error("[meeting-summarize] report trigger error:", e?.message);
    // Non-critical — summary was already saved
  }

  // Build full transcript for frontend to pass to generate-report
  const fullTranscriptParts2 = [];
  if (meeting.title) fullTranscriptParts2.push(`Meeting: ${meeting.title}`);
  if (meeting.meeting_type) fullTranscriptParts2.push(`Typ: ${meeting.meeting_type}`);
  if (meeting.started_at) fullTranscriptParts2.push(`Datum: ${new Date(meeting.started_at).toLocaleString("de-DE")}`);
  if (contextStr.trim()) fullTranscriptParts2.push(`\nKontext:\n${contextStr}`);
  if (chatTranscript.trim()) fullTranscriptParts2.push(`\nVollständiges Gespräch:\n${chatTranscript}`);
  if (notesStr.trim()) fullTranscriptParts2.push(`\nNotizen & Entscheidungen:\n${notesStr}`);

  return res.status(200).json({
    ok: true,
    summary: saved,
    report_session_id: reportSessionId,
    report_transcript: fullTranscriptParts2.join("\n"),
  });
}

// ---------------------------------------------------------------------------
// Action: summary — Summary abrufen
// ---------------------------------------------------------------------------

async function handleSummary(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "Missing meeting id" });

  const supabase = getSupabase();

  // Verify ownership
  const { data: meeting } = await supabase
    .from("meetings")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!meeting) return res.status(404).json({ error: "Meeting not found" });

  const { data: summary } = await supabase
    .from("meeting_summary")
    .select("*")
    .eq("meeting_id", id)
    .maybeSingle();

  return res.status(200).json({ ok: true, summary: summary || null });
}

// ---------------------------------------------------------------------------
// Action: delete — Meeting löschen
// ---------------------------------------------------------------------------

async function handleDelete(req, res) {
  if (req.method !== "POST" && req.method !== "DELETE") return res.status(405).json({ error: "Method not allowed" });

  const user = await requireAuth(req, res);
  if (!user) return;

  const body = parseBody(req);
  const { meeting_id } = body;
  if (!meeting_id) return res.status(400).json({ error: "Missing meeting_id" });

  const supabase = getSupabase();

  // Verify ownership
  const { data: meeting } = await supabase
    .from("meetings")
    .select("id")
    .eq("id", meeting_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!meeting) return res.status(404).json({ error: "Meeting not found" });

  // Delete meeting (cascades to context, notes, summary via ON DELETE CASCADE)
  // Children with parent_meeting_id will get SET NULL automatically
  const { error } = await supabase
    .from("meetings")
    .delete()
    .eq("id", meeting_id);

  if (error) {
    console.error("Meeting delete error:", error);
    return res.status(500).json({ error: "Failed to delete meeting" });
  }

  return res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  const action = req.query?.action;
  switch (action) {
    case "create":    return handleCreate(req, res);
    case "get":       return handleGet(req, res);
    case "list":      return handleList(req, res);
    case "phase":     return handlePhase(req, res);
    case "context":   return handleContext(req, res);
    case "note":      return handleNote(req, res);
    case "message":   return handleMessage(req, res);
    case "summarize": return handleSummarize(req, res);
    case "summary":   return handleSummary(req, res);
    case "delete":    return handleDelete(req, res);
    default:
      return res.status(400).json({ error: "Missing or invalid ?action. Use: create | get | list | phase | context | note | message | summarize | summary" });
  }
}
