// api/session.js
import { createClient } from "@supabase/supabase-js";
import { buildSophiePrompt, mapPlanToTier } from "../lib/sophie-core.js";
// calcBrainstormPhase not needed for voice — phases are embedded in prompt
import { DEFAULT_FREE_TOKENS, SECONDS_PER_TOKEN, SECONDS_PER_TOKEN_ECO } from "../lib/billing-constants.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: "Missing Authorization Bearer token" });
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser(token);

    if (userErr || !user) {
      return res.status(401).json({ error: "Invalid token" });
    }


    let handover = null;
    try {
      const rawHandover = req.headers["x-sophie-handover"];
      if (rawHandover) {
        handover = JSON.parse(Buffer.from(String(rawHandover), "base64").toString("utf8"));
      }
    } catch (e) {
      console.warn("Invalid handover header:", e?.message || e);
      handover = null;
    }

    // Session mode selected by user via UI before session start
    const rawSessionMode = String(req.headers["x-sophie-session-mode"] || "").toLowerCase().trim();
    const sessionMode = ["brainstorm", "meeting", "salespitch"].includes(rawSessionMode) ? rawSessionMode : null;
    const meetingId = String(req.headers["x-sophie-meeting-id"] || "").trim() || null;

    // Brainstorm config — base64-encoded JSON header, only relevant when sessionMode === "brainstorm"
    let brainstormConfig = null;
    if (sessionMode === "brainstorm") {
      try {
        const rawBs = req.headers["x-sophie-brainstorm-config"];
        if (rawBs) {
          const parsed = JSON.parse(Buffer.from(String(rawBs), "base64").toString("utf8"));
          brainstormConfig = {
            topic:              String(parsed.topic || "").slice(0, 500) || null,
            goal:               parsed.goal ? String(parsed.goal).slice(0, 500) : null,
            mode:               ["solo", "group"].includes(parsed.mode) ? parsed.mode : "solo",
            depth:              ["short", "standard", "deep"].includes(parsed.depth) ? parsed.depth : "standard",
            duration_minutes:   Number.isFinite(parsed.duration_minutes) && parsed.duration_minutes > 0 ? parsed.duration_minutes : null,
            facilitation_style: ["open", "guided", "challenge"].includes(parsed.facilitation_style) ? parsed.facilitation_style : "open",
            silent_hints:       parsed.silent_hints !== false,
          };
        }
      } catch (e) {
        console.warn("[session] Invalid brainstorm config header:", e?.message);
      }
    }

    // ---------------------------
    // Session ending config
    // ---------------------------
    // These values are meant for the frontend timer logic.
    // Example:
    // - at <= 30s remaining: prepare soft ending / summary request
    // - at <= 15s remaining: play spoken summary + show summary card
    const SOFT_END_WARNING_SECONDS = parseInt(process.env.SOFT_END_WARNING_SECONDS || "30", 10);
    const SOFT_END_SUMMARY_SECONDS = parseInt(process.env.SOFT_END_SUMMARY_SECONDS || "15", 10);

    // Safety normalization
    const softEndWarningSeconds =
      Number.isFinite(SOFT_END_WARNING_SECONDS) && SOFT_END_WARNING_SECONDS > 5
        ? SOFT_END_WARNING_SECONDS
        : 30;

    const softEndSummarySeconds =
      Number.isFinite(SOFT_END_SUMMARY_SECONDS) &&
      SOFT_END_SUMMARY_SECONDS > 0 &&
      SOFT_END_SUMMARY_SECONDS < softEndWarningSeconds
        ? SOFT_END_SUMMARY_SECONDS
        : 15;

    // ---------------------------
    // PARALLEL BATCH 1: Subscription, Usage, Lock (independent queries)
    // ---------------------------
    const SESSION_LOCK_TTL_SECONDS = parseInt(process.env.SESSION_LOCK_TTL_SECONDS || "12", 10);

    const [subResult, usageResult, lockResult] = await Promise.all([
      supabase.from("user_subscriptions").select("is_active, status, plan").eq("user_id", user.id).maybeSingle(),
      supabase.from("user_usage").select("free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance").eq("user_id", user.id).maybeSingle(),
      supabase.rpc("acquire_realtime_lock", { p_user_id: user.id, p_ttl_seconds: SESSION_LOCK_TTL_SECONDS }),
    ]);

    // --- Process lock result (fail-fast) ---
    const lockAllowed = Array.isArray(lockResult.data) && lockResult.data[0]?.allowed === true;
    if (lockResult.error || !lockAllowed) {
      return res.status(429).json({
        error: "busy",
        message: "Sophie is already in a call. Please close other tabs and try again.",
      });
    }

    // --- Process subscription ---
    let isPremium = false;
    let plan = null;
    if (subResult.error) {
      console.warn("Subscription lookup error:", subResult.error.message);
    } else if (subResult.data) {
      const sub = subResult.data;
      isPremium = !!(sub.is_active || sub.status === "active" || sub.status === "trialing");
      plan = sub.plan || null;
    }

    const tier = mapPlanToTier(plan, isPremium);
    const sessionLimit = tier === "partner" ? 5 : tier === "friend" ? 3 : tier === "assistant" ? 1 : 0;
    const mode = (tier === "friend" || tier === "partner") ? "best_friend" : "companion";

    // --- Process usage ---
    let usage = usageResult.data;
    if (usageResult.error) {
      return res.status(500).json({ error: usageResult.error.message });
    }

    if (!usage) {
      const { data: created, error: createErr } = await supabase
        .from("user_usage")
        .upsert({
          user_id: user.id,
          free_tokens_total: DEFAULT_FREE_TOKENS, free_tokens_used: 0,
          paid_tokens_total: 0, paid_tokens_used: 0, topup_tokens_balance: 0,
        }, { onConflict: "user_id" })
        .select("free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance")
        .single();
      if (!createErr && created) usage = created;
    }

    const freeTotal = usage?.free_tokens_total ?? DEFAULT_FREE_TOKENS;
    const freeUsed = usage?.free_tokens_used ?? 0;
    const freeRemaining = Math.max(0, freeTotal - freeUsed);

    const paidTotal = usage?.paid_tokens_total ?? 0;
    const paidUsed = usage?.paid_tokens_used ?? 0;
    const paidRemaining = Math.max(0, paidTotal - paidUsed);

    const topupRemaining = Math.max(0, usage?.topup_tokens_balance ?? 0);

    const remaining = freeRemaining + paidRemaining + topupRemaining;

    if (remaining <= 0) {
      const reason = isPremium
        ? "subscription_quota_exhausted"
        : "no_active_subscription";

      return res.status(402).json({
        error: "No remaining time",
        reason,
        remaining_tokens: 0,
        remaining_seconds: 0,
        is_premium: isPremium,
        plan: plan,
        subscription_active: isPremium,
        soft_end_enabled: true,
        soft_end_warning_seconds: softEndWarningSeconds,
        soft_end_summary_seconds: softEndSummarySeconds,
      });
    }

    // ---------------------------
    // DAILY BUDGET LIMIT (global) - only for truly free users
    // ---------------------------
    const DAILY_FREE_SECONDS_CAP = parseInt(process.env.DAILY_FREE_SECONDS_CAP || "3000", 10);
    const FREE_SECONDS_PER_TRIAL = 120;
    const isPayingUser = !!(isPremium || paidRemaining > 0 || topupRemaining > 0);

    if (!isPayingUser) {
      const { data: budgetRow, error: budgetErr } = await supabase.rpc("reserve_free_seconds", {
        p_seconds: FREE_SECONDS_PER_TRIAL,
        p_cap: DAILY_FREE_SECONDS_CAP,
      });

      const allowed = Array.isArray(budgetRow) && budgetRow[0]?.allowed === true;

      if (budgetErr || !allowed) {
        return res.status(429).json({
          error: "busy",
          message: "Sophie has too many calls right now. Please try later.",
        });
      }
    }

    // ---------------------------
    // PARALLEL BATCH 2: Profile, Relationship, Sessions (independent reads)
    // ---------------------------
    let profile = {
      first_name: "", preferred_name: "", preferred_addressing: "", preferred_pronoun: "",
      preferred_language: "en", notes: "", age: null, relationship_status: "", occupation: "",
      conversation_style: "", topics_like: [], topics_avoid: [], memory_confidence: "",
      last_confirmed_at: null,
    };

    let rel = {
      tone_baseline: "", openness_level: "", emotional_patterns: "", last_interaction_summary: "",
    };

    let recentSessions = [];

    try {
      const [profResult, relResult, sessResult] = await Promise.all([
        supabase.from("user_profile").select(
          "first_name, preferred_name, preferred_addressing, preferred_pronoun, preferred_language, notes, age, relationship_status, " +
          "occupation, conversation_style, topics_like, topics_avoid, memory_confidence, last_confirmed_at, custom_rules, eco_mode, memory_file"
        ).eq("user_id", user.id).maybeSingle(),
        supabase.from("user_relationship").select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary").eq("user_id", user.id).maybeSingle(),
        supabase.from("user_sessions").select("session_date, emotional_tone, stress_level, closeness_level, short_summary").eq("user_id", user.id).order("session_date", { ascending: false }).limit(sessionLimit),
      ]);

      if (profResult.error) console.warn("Profile lookup error:", profResult.error.message);
      if (profResult.data) {
        const prof = profResult.data;
        profile = {
          first_name: (prof.first_name || "").trim(),
          preferred_name: (prof.preferred_name || "").trim(),
          preferred_addressing: (prof.preferred_addressing || "").trim(),
          preferred_pronoun: (prof.preferred_pronoun || "").trim(),
          preferred_language: (prof.preferred_language || "en").toLowerCase().trim(),
          notes: (prof.notes || "").trim(),
          age: prof.age ?? null,
          relationship_status: (prof.relationship_status || "").trim(),
          occupation: (prof.occupation || "").trim(),
          conversation_style: (prof.conversation_style || "").trim(),
          topics_like: Array.isArray(prof.topics_like)
            ? prof.topics_like.map((x) => String(x || "").trim()).filter(Boolean)
            : [],
          topics_avoid: Array.isArray(prof.topics_avoid)
            ? prof.topics_avoid.map((x) => String(x || "").trim()).filter(Boolean)
            : [],
          memory_confidence: (prof.memory_confidence || "").trim(),
          last_confirmed_at: prof.last_confirmed_at ?? null,
          eco_mode: !!prof.eco_mode,
          memory_file: (prof.memory_file || "").trim(),
        };
      }

      if (relResult.error) console.warn("Relationship lookup error:", relResult.error.message);
      if (relResult.data) {
        rel = {
          tone_baseline: (relResult.data.tone_baseline || "").trim(),
          openness_level: (relResult.data.openness_level || "").trim(),
          emotional_patterns: (relResult.data.emotional_patterns || "").trim(),
          last_interaction_summary: (relResult.data.last_interaction_summary || "").trim(),
        };
      }

      if (sessResult.error) console.warn("Sessions lookup error:", sessResult.error.message);
      if (Array.isArray(sessResult.data)) recentSessions = sessResult.data;
    } catch (e) {
      console.warn("Memory lookup crashed:", e?.message || e);
    }

    // ---------------------------
    // Structured memory (long-term + short-term + reports)
    // Skip for first-session users — they have no memory/reports/conversations yet
    // ---------------------------
    const isLikelyFirstSession =
      (!profile.first_name || profile.first_name.trim() === "") &&
      (!rel.last_interaction_summary || rel.last_interaction_summary.trim() === "");

    let structuredMemory = null;
    let recentMemories = [];
    let recentReports = [];
    let recentConversations = [];
    if (!isLikelyFirstSession) {
      try {
        const [ltmRes, stmRes, reportsRes, recentMsgsRes] = await Promise.all([
          supabase.from("sophie_long_term_memory").select("*").eq("user_id", user.id).maybeSingle(),
          supabase.from("sophie_short_term_memory").select("summary,open_topics,pending_decisions,next_steps,importance_score,mode,created_at").eq("user_id", user.id).gt("expires_at", new Date().toISOString()).order("importance_score", { ascending: false }).limit(5),
          supabase.from("conversation_outputs").select("title,short_summary,report_html,report_style,created_at,session_id,user_sessions!inner(user_id)").eq("user_sessions.user_id", user.id).not("report_html", "is", null).order("created_at", { ascending: false }).limit(3),
          supabase.from("conversation_messages").select("text,role,created_at,session_id,user_sessions!inner(user_id,session_date)").eq("user_sessions.user_id", user.id).eq("role", "user").order("created_at", { ascending: false }).limit(30),
        ]);
        structuredMemory = ltmRes?.data || null;
        recentMemories = stmRes?.data || [];
        recentReports = (reportsRes?.data || []).map(r => ({
          title: r.title || "Report",
          summary: r.short_summary || (r.report_html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500),
          mode: r.report_style || null,
          date: r.created_at,
        }));
        recentConversations = recentMsgsRes?.data || [];
      } catch (e) {
        console.warn("Structured memory lookup crashed:", e?.message || e);
      }
    }

    // ---------------------------
    // Backward compat: SOPHIE_PREFS in notes (optional, but WITHOUT language fallback)
    // ---------------------------
    const prefsLine =
      (profile.notes || "").split("\n").find((ln) => ln.includes("SOPHIE_PREFS:")) || "";

    const notesFallback = {
      preferred_name: "",
      preferred_addressing: "",
      preferred_pronoun: "",
    };

    if (prefsLine) {
      const mName = prefsLine.match(/preferred_name=([^;]*)/i);
      const mAddr = prefsLine.match(/preferred_addressing=([^;]*)/i);
      const mPro = prefsLine.match(/preferred_pronoun=([^;]*)/i);

      notesFallback.preferred_name = (mName?.[1] || "").trim();
      notesFallback.preferred_addressing = (mAddr?.[1] || "").trim();
      notesFallback.preferred_pronoun = (mPro?.[1] || "").trim();
    }

    const effectivePreferredName =
      profile.preferred_name || notesFallback.preferred_name || profile.first_name || "";

    let effectiveAddressing = (
      profile.preferred_addressing ||
      notesFallback.preferred_addressing ||
      ""
    )
      .toLowerCase()
      .trim();

    if (effectiveAddressing !== "informal" && effectiveAddressing !== "formal") {
      effectiveAddressing = "";
    }

    const effectivePronoun = profile.preferred_pronoun || notesFallback.preferred_pronoun || "";

    // ✅ HARD language whitelist (prevents fr/es/ja etc.)
    let preferredLanguage = String(
      handover?.language || profile.preferred_language || "en"
    ).toLowerCase().trim();
    if (!["en", "de", "fr"].includes(preferredLanguage)) {
      preferredLanguage = "en";
    }

    const handoverName = String(handover?.userName || "").trim();
    const hasHandoverContext = !!(
      handover && (
        handoverName ||
        (Array.isArray(handover?.recentMessages) && handover.recentMessages.length > 0) ||
        (handover?.summary && String(handover.summary).trim() !== "")
      )
    );

    // ✅ First-session Heuristik
    const isFirstSession = !hasHandoverContext &&
      (!profile.first_name || profile.first_name.trim() === "") &&
      (!rel.last_interaction_summary || rel.last_interaction_summary.trim() === "");

    // Load imported context from other AIs
    let importedContext = "";
    try {
      const { data: sources } = await supabase
        .from("source_connections")
        .select("id")
        .eq("user_id", user.id)
        .eq("status", "active");

      if (sources?.length > 0) {
        const sourceIds = sources.map(s => s.id);
        const { data: insights } = await supabase
          .from("source_items")
          .select("summary, extracted_insights, raw_content, zone")
          .in("source_id", sourceIds)
          .in("zone", ["B", "C"])
          .limit(30);

        const insightTexts = (insights || [])
          .map(i => {
            if (i.extracted_insights && Object.keys(i.extracted_insights).length > 0) return JSON.stringify(i.extracted_insights);
            return i.summary;
          })
          .filter(t => t && t.length > 10 && !t.startsWith("Import von"));

        if (insightTexts.length > 0) {
          importedContext = "\n\nIMPORTIERTER KONTEXT:\n" + insightTexts.slice(0, 20).join("\n");
        } else {
          // Fallback: build structured overview from Zone A
          const { data: rawItems } = await supabase
            .from("source_items")
            .select("raw_content")
            .in("source_id", sourceIds)
            .eq("zone", "A")
            .limit(5);

          const raw = (rawItems || []).map(i => i.raw_content).filter(Boolean).join("\n\n");
          if (raw.length > 0) {
            const titles = raw.split("\n")
              .filter(line => line.startsWith("# ") && line !== "# Untitled")
              .map(line => line.replace("# ", "").trim())
              .filter(t => t.length > 3);

            const userMsgs = raw.split("\n")
              .filter(line => line.startsWith("[human]: "))
              .map(line => line.replace("[human]: ", "").trim())
              .filter(msg => msg.length > 30 && !msg.match(/^(ja|nein|ok|danke|hi|hallo|gut)/i));

            const parts = [];
            if (titles.length > 0) {
              parts.push("GESPRÄCHSTHEMEN (" + titles.length + " Gespräche):\n" + titles.slice(0, 40).map(t => "- " + t).join("\n"));
            }
            if (userMsgs.length > 0) {
              const sampled = [];
              if (userMsgs.length > 0) sampled.push(userMsgs[0]);
              if (userMsgs.length > 5) sampled.push(userMsgs[Math.floor(userMsgs.length / 3)]);
              if (userMsgs.length > 10) sampled.push(userMsgs[Math.floor(userMsgs.length * 2 / 3)]);
              if (userMsgs.length > 2) sampled.push(userMsgs[userMsgs.length - 1]);
              parts.push("BEISPIEL-ANFRAGEN DES USERS:\n" + sampled.map(m => "- " + m.slice(0, 150)).join("\n"));
            }
            if (parts.length > 0) {
              importedContext = "\n\nIMPORTIERTER KONTEXT (aus früheren KI-Gesprächen):\n" + parts.join("\n\n");
            }
          }
        }
      }
    } catch (e) {
      console.warn("Import context load error:", e?.message);
    }

    // ── Meeting Context: Load previous meeting's decisions, actions, open points ──
    let meetingContext = null;
    if (sessionMode === "meeting" && meetingId) {
      try {
        // Load current meeting to find parent
        const { data: mtg } = await supabase.from("meetings")
          .select("title, meeting_type, parent_meeting_id")
          .eq("id", meetingId).maybeSingle();

        const contextParts = [];
        if (mtg?.title) contextParts.push(`Aktuelles Meeting: ${mtg.title}`);

        // Load meeting_context entries (agenda, goals, etc.)
        const { data: ctxRows } = await supabase.from("meeting_context")
          .select("context_type, content").eq("meeting_id", meetingId);
        if (ctxRows?.length) {
          contextParts.push("\nVorbereitung:");
          ctxRows.forEach(c => contextParts.push(`[${c.context_type}] ${c.content}`));
        }

        // Load parent meeting's structured data (decisions, actions, open points)
        if (mtg?.parent_meeting_id) {
          const { data: parentSummary } = await supabase.from("meeting_summary")
            .select("short_summary, decisions, action_items, open_points, lean_check")
            .eq("meeting_id", mtg.parent_meeting_id).maybeSingle();

          if (parentSummary) {
            contextParts.push("\n── VORHERIGES MEETING ──");
            if (parentSummary.short_summary) contextParts.push(`Zusammenfassung: ${parentSummary.short_summary}`);

            const decisions = parentSummary.decisions || [];
            if (decisions.length > 0) {
              contextParts.push("\nBESCHLÜSSE (bereits entschieden — bei Widerspruch darauf hinweisen!):");
              decisions.forEach(d => contextParts.push(`• ${d.text}${d.owner ? ` (${d.owner})` : ""}`));
            }

            const actions = parentSummary.action_items || [];
            const openActions = actions.filter(a => !a.status || a.status === "open");
            if (openActions.length > 0) {
              contextParts.push("\nOFFENE ACTION ITEMS (Status nachfragen!):");
              openActions.forEach(a => contextParts.push(`• ${a.text}${a.owner ? ` → ${a.owner}` : ""}${a.due ? ` (Frist: ${a.due})` : ""}`));
            }

            const openPoints = parentSummary.open_points || [];
            if (openPoints.length > 0) {
              contextParts.push("\nUNGELÖSTE FRAGEN (ansprechen wenn relevant):");
              openPoints.forEach(o => contextParts.push(`• ${o.text}`));
            }

            // Lean data from previous meeting — carry forward unvalidated items
            const lean = parentSummary.lean_check;
            if (lean) {
              const leanParts = [];
              if (lean.assumptions?.length) {
                leanParts.push("UNGEPRÜFTE ANNAHMEN (nachfragen ob validiert!):");
                lean.assumptions.forEach(a => leanParts.push(`  ⚠️ ${a}`));
              }
              if (lean.hypotheses?.length) {
                leanParts.push("OFFENE HYPOTHESEN (wurde getestet?):");
                lean.hypotheses.forEach(h => leanParts.push(`  💡 ${h}`));
              }
              if (lean.tests?.length) {
                leanParts.push("BESCHLOSSENE TESTS (Ergebnis nachfragen!):");
                lean.tests.forEach(t => leanParts.push(`  🧪 ${t}`));
              }
              if (lean.signals?.length) {
                leanParts.push("DEFINIERTE SIGNALE (eingetreten?):");
                lean.signals.forEach(s => leanParts.push(`  🚦 ${s}`));
              }
              if (leanParts.length > 0) {
                contextParts.push("\nLEAN CHECK (aus letztem Meeting — Status prüfen!):");
                contextParts.push(...leanParts);
              }
            }

            contextParts.push("── ENDE VORHERIGES MEETING ──");
          }
        }

        if (contextParts.length > 0) meetingContext = contextParts.join("\n");
        console.log(`[session] Meeting context loaded: ${meetingContext?.length || 0} chars`);
      } catch (e) {
        console.warn("[session] Meeting context load error:", e?.message);
      }
    }

    const sophiePrompt = buildSophiePrompt({
      tier,
      sessionMode,
      meetingPhase: sessionMode === "meeting" ? "live" : null,
      meetingContext,
      isFirstSession,
      hasHandover: hasHandoverContext,
      handoverContext: hasHandoverContext ? handover : null,
      pitchRetry: handover?.pitchRetry === true,
      pitchDemo: handover?.pitchDemo === true,
      brainstormConfig,
      pitchContext: await (async () => {
        if (!handover?.pitchRetry && !handover?.pitchDemo) return null;
        const ctx = {
          topic: handover.pitchTopic || "",
          audience: handover.audience || "",
          previousScores: handover.previousScores || null,
          previousWeaknesses: handover.previousWeaknesses || [],
          previousStrengths: handover.previousStrengths || [],
          previousVersion: handover.previousVersion || 1,
          previousDemoTranscript: handover.previousDemoTranscript || "",
          previousDemoSelfCritique: handover.previousDemoSelfCritique || "",
          pitchTranscript: "",
          reportSummary: "",
          prewrittenDemoPitch: "", // passed via kickoff, not header (too large)
        };

        // Load transcript + report SERVER-SIDE (avoids HTTP header size limits)
        if (handover.pitchDemo) {
          const sid = handover.previousPitchSessionId || null;
          if (sid) {
            try {
              // Load conversation transcript
              const { data: msgs } = await supabase
                .from('conversation_messages')
                .select('role, text')
                .eq('session_id', sid)
                .order('seq', { ascending: true })
                .limit(100);
              if (msgs?.length) {
                ctx.pitchTranscript = msgs
                  .filter(m => m.text?.trim())
                  .map(m => `[${m.role}]: ${m.text}`)
                  .join('\n')
                  .slice(0, 6000);
              }

              // Load report text
              const { data: output } = await supabase
                .from('conversation_outputs')
                .select('report_html')
                .eq('session_id', sid)
                .maybeSingle();
              if (output?.report_html) {
                ctx.reportSummary = output.report_html
                  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 4000);
              }

              console.log(`[session] loaded demo context for ${sid}: transcript=${ctx.pitchTranscript.length}c, report=${ctx.reportSummary.length}c`);
            } catch (e) { console.error('[session] demo context load failed:', e?.message); }
          }
        }

        return ctx;
      })(),
      customRules: Array.isArray(profile.custom_rules) ? profile.custom_rules : [],
      language: preferredLanguage,
      user: {
        name: effectivePreferredName,
        addressing: effectiveAddressing,
        pronoun: effectivePronoun,
        occupation: profile.occupation,
        conversationStyle: profile.conversation_style,
        topicsLike: profile.topics_like,
        topicsAvoid: profile.topics_avoid,
        memoryFile: profile.memory_file || "",
      },
      memory: {
        sessions: recentSessions,
        relationship: rel,
      },
      structuredMemory,
      recentMemories,
      recentReports,
      recentConversations,
      channel: "voice",
    });

    // Tool instructions — only for modes that have tools active
    // Brainstorm/Meeting only get send_chat_note, no research/weather/news tools
    const hasFullTools = !sessionMode || sessionMode === "salespitch";
    const toolInstructions = hasFullTools ? `\n\nDEEP RESEARCH: Du hast Zugriff auf ein Tool namens "deep_research". ` +
      `Nutze es wenn der User eine Frage stellt die tiefere Analyse, Faktenprüfung, oder eine zweite Meinung braucht. ` +
      `Sage dabei "Lass mich das kurz prüfen..." und nutze dann das Tool. ` +
      `Erwähne NICHT dass du andere KIs befragt hast — sage einfach die verbesserte Antwort.` +
      `\n\nSEARCH HISTORY: Du hast ein Tool namens "search_history". ` +
      `Nutze es wenn der User nach früheren Gesprächen oder Projekten fragt. ` +
      `Sage "Moment, ich schaue in deiner History nach..." und nutze dann das Tool.` +
      `\n\nWETTER: Du hast ein Tool namens "get_weather". ` +
      `Nutze es bei Fragen nach Wetter, Temperatur oder Outdoor-Bedingungen. ` +
      `Sage "Moment, ich schaue nach dem Wetter..." und nutze das Tool.` +
      `\n\nWEB-SUCHE: Du hast ein Tool namens "web_search". ` +
      `Nutze es für aktuelle Fakten, Preise, Ereignisse. Sage "Lass mich das kurz nachschauen..."` +
      `\n\nNACHRICHTEN: Du hast ein Tool namens "get_news". ` +
      `Nutze es bei Fragen nach aktuellen Nachrichten. Sage "Ich prüfe die Nachrichten..."` +
      `\n\nWIKIPEDIA: Du hast ein Tool namens "get_wikipedia". ` +
      `Nutze es für Faktenwissen, Definitionen, Biographien. ` +
      `Sage NIEMALS "Ich habe keinen Zugriff" — du HAST Zugriff über deine Tools!` : "";

    // Chat interaction instructions — always active (user can type during any mode)
    const chatInstruction = `\n\nCHAT MESSAGES: ` +
      `Messages prefixed with [CHAT MESSAGE] are text messages typed during the voice session. ` +
      `Acknowledge naturally: "Ah, I see your message..." Then incorporate into your response.` +
      `\n\nCHAT NOTE TOOL (send_chat_note): ` +
      `Send short text notes to the chat panel for structured info better READ than heard. ` +
      `Keep notes very short (max 2-3 lines, max 280 chars). Only when visual text genuinely helps.`;

    const researchInstruction = toolInstructions + chatInstruction;

    // STARTUP RULE: The opening turn is handled by a separate response.create instruction from the frontend.
    // This block just tells the model not to self-generate a greeting from the system prompt alone.
    const startupGuard = `\n\n=== OPENING TURN ===
Your opening turn will come with its own specific instructions. For your opening turn, follow THOSE instructions, not the general rules above.
Do NOT reference memory, past topics, or tools in your opening turn. Do NOT add questions like "Was möchtest du besprechen?" or "Wie kann ich helfen?" unless the opening instructions explicitly tell you to.
After the opening turn, all the rules above apply normally.`;
    const fullPrompt = sophiePrompt + importedContext + researchInstruction + startupGuard;

    // ---------------------------
    // Realtime session create
    // ---------------------------
    const isEco = !!profile.eco_mode;
    const realtimeModel = isEco ? "gpt-realtime-mini" : "gpt-realtime";

    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: realtimeModel,
        voice: "shimmer",
        modalities: ["audio", "text"],
        temperature: 0.7,
        speed: 1.0,
        instructions: fullPrompt,
        input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
        input_audio_format: "pcm16",
        turn_detection: {
          type: "server_vad",
          threshold: 0.6,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          idle_timeout_ms: null,
          create_response: false,
          interrupt_response: true,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: errorText });
    }

    const data = await response.json();

    const secPerToken = isEco ? SECONDS_PER_TOKEN_ECO : SECONDS_PER_TOKEN;
    const remainingVoiceSeconds = remaining * secPerToken;

    return res.status(200).json({
      ...data,
      remaining_tokens: remaining,
      remaining_seconds: remainingVoiceSeconds,
      is_premium: isPremium,
      plan: plan,
      mode: mode,
      eco_mode: isEco,
      user_id: user.id,
      preferred_name: profile.preferred_name || profile.first_name || "",
      preferred_language: preferredLanguage,
      is_first_session: isFirstSession,

      // Soft ending config for frontend
      soft_end_enabled: true,
      soft_end_warning_seconds: softEndWarningSeconds,
      soft_end_summary_seconds: softEndSummarySeconds,
      summary_required_before_cut: true,

      // Helpful info for UI / debug
      free_remaining_tokens: freeRemaining,
      paid_remaining_tokens: paidRemaining,
      topup_remaining_tokens: topupRemaining,
    });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
