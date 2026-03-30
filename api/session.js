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
    // Subscription status (nur UI/Status)
    // ---------------------------
    let isPremium = false;
    let plan = null;

    try {
      const { data: sub, error: subErr } = await supabase
        .from("user_subscriptions")
        .select("is_active, status, plan")
        .eq("user_id", user.id)
        .maybeSingle();

      if (subErr) {
        console.warn("Subscription lookup error:", subErr.message);
      }

      const active = !!(sub?.is_active || sub?.status === "active" || sub?.status === "trialing");
      isPremium = active;
      plan = sub?.plan || null;
    } catch (e) {
      console.warn("Subscription lookup crashed:", e?.message || e);
    }

    // ---------------------------
    // Mode (Companion vs Best Friend)
    // Companion = plan "start" (or no active plan)
    // Best Friend = plan "plus"
    // ---------------------------
    const tier = mapPlanToTier(plan, isPremium);
    const sessionLimit = tier === "partner" ? 5 : tier === "friend" ? 3 : tier === "assistant" ? 1 : 0;
    const mode = (tier === "friend" || tier === "partner") ? "best_friend" : "companion"; // returned to frontend

    // ---------------------------
    // Usage / Remaining tokens (für ALLE)
    // ---------------------------
    const { data: usage, error: usageErr } = await supabase
      .from("user_usage")
      .select("free_tokens_total, free_tokens_used, paid_tokens_total, paid_tokens_used, topup_tokens_balance")
      .eq("user_id", user.id)
      .maybeSingle();

    if (usageErr) {
      return res.status(500).json({ error: usageErr.message });
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
    // 1 ACTIVE SESSION PER USER (anti tab/refresh spam)
    // ---------------------------
    const SESSION_LOCK_TTL_SECONDS = parseInt(process.env.SESSION_LOCK_TTL_SECONDS || "12", 10);

    const { data: lockRow, error: lockErr } = await supabase.rpc("acquire_realtime_lock", {
      p_user_id: user.id,
      p_ttl_seconds: SESSION_LOCK_TTL_SECONDS,
    });

    const lockAllowed = Array.isArray(lockRow) && lockRow[0]?.allowed === true;

    if (lockErr || !lockAllowed) {
      return res.status(429).json({
        error: "busy",
        message: "Sophie is already in a call. Please close other tabs and try again.",
      });
    }

    // ---------------------------
    // DAILY BUDGET LIMIT (global) - only for truly free users
    // ---------------------------
    const DAILY_FREE_SECONDS_CAP = parseInt(process.env.DAILY_FREE_SECONDS_CAP || "3000", 10);

    // Reserve exactly the free seconds you grant per free user (2 minutes)
    const FREE_SECONDS_PER_TRIAL = 120;

    // Only throttle users who are truly free (no subscription AND no paid/topup time)
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
    // Profile + Relationship laden
    // ---------------------------
    let profile = {
      first_name: "",
      preferred_name: "",
      preferred_addressing: "",
      preferred_pronoun: "",
      preferred_language: "en",
      notes: "",
      age: null,
      relationship_status: "",
      occupation: "",
      conversation_style: "",
      topics_like: [],
      topics_avoid: [],
      memory_confidence: "",
      last_confirmed_at: null,
    };

    let rel = {
      tone_baseline: "",
      openness_level: "",
      emotional_patterns: "",
      last_interaction_summary: "",
    };

    try {
      const { data: prof, error: profErr } = await supabase
        .from("user_profile")
        .select(
          "first_name, preferred_name, preferred_addressing, preferred_pronoun, preferred_language, notes, age, relationship_status, " +
            "occupation, conversation_style, topics_like, topics_avoid, memory_confidence, last_confirmed_at, custom_rules, eco_mode"
        )
        .eq("user_id", user.id)
        .maybeSingle();

      if (profErr) {
        console.warn("Profile lookup error:", profErr.message);
      }

      if (prof) {
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
        };
      }

      const { data: relData, error: relErr } = await supabase
        .from("user_relationship")
        .select("tone_baseline, openness_level, emotional_patterns, last_interaction_summary")
        .eq("user_id", user.id)
        .maybeSingle();

      if (relErr) {
        console.warn("Relationship lookup error:", relErr.message);
      }

      if (relData) {
        rel = {
          tone_baseline: (relData.tone_baseline || "").trim(),
          openness_level: (relData.openness_level || "").trim(),
          emotional_patterns: (relData.emotional_patterns || "").trim(),
          last_interaction_summary: (relData.last_interaction_summary || "").trim(),
        };
      }
    } catch (e) {
      console.warn("Memory lookup crashed:", e?.message || e);
    }

    // ---------------------------
    // Last sessions (1 for Companion, 3 for Best Friend)
    // ---------------------------
    let recentSessions = [];
    try {
      const { data: sess, error: sessErr } = await supabase
        .from("user_sessions")
        .select("session_date, emotional_tone, stress_level, closeness_level, short_summary")
        .eq("user_id", user.id)
        .order("session_date", { ascending: false })
        .limit(sessionLimit);

      if (sessErr) {
        console.warn("Sessions lookup error:", sessErr.message);
      }

      if (Array.isArray(sess)) {
        recentSessions = sess;
      }
    } catch (e) {
      console.warn("Sessions lookup crashed:", e?.message || e);
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
      },
      memory: {
        sessions: recentSessions,
        relationship: rel,
      },
      channel: "voice",
    });

    // Add deep_research capability to prompt
    const researchInstruction = `\n\nDEEP RESEARCH: Du hast Zugriff auf ein Tool namens "deep_research". ` +
      `Nutze es wenn der User eine Frage stellt die tiefere Analyse, Faktenprüfung, oder eine zweite Meinung braucht. ` +
      `Beispiele: komplexe Sachfragen, Vergleiche, Analysen, oder wenn du dir bei einer Antwort unsicher bist. ` +
      `Sage dabei natürlich etwas wie "Lass mich das kurz prüfen..." oder "Einen Moment, ich schaue nach..." ` +
      `und nutze dann das Tool. Die Ergebnisse kommen von anderen KI-Modellen (Claude, Gemini, Mistral) ` +
      `die die gleiche Frage unabhängig beantworten. Nutze ihre Insights um deine Antwort zu verbessern. ` +
      `Erwähne NICHT dass du andere KIs befragt hast — sage einfach die verbesserte Antwort.` +
      `\n\nSEARCH HISTORY: Du hast Zugriff auf ein Tool namens "search_history". ` +
      `Nutze es wenn der User nach früheren Gesprächen, Projekten oder Informationen aus seiner Chat-History fragt. ` +
      `Beispiele: "Was hatten wir zum Thema X besprochen?", "Finde den Chat über Y", "Woran habe ich zuletzt gearbeitet?", ` +
      `"Erinnerst du dich an...". Sage natürlich "Moment, ich schaue in deiner History nach..." und nutze dann das Tool. ` +
      `Das Ergebnis enthält Auszüge aus importierten Gesprächen. Fasse die relevanten Informationen zusammen.` +
      `\n\nWETTER: Du hast ein Tool namens "get_weather". ` +
      `Nutze es wenn der User nach dem Wetter, der Temperatur, Regen, oder Outdoor-Bedingungen fragt. ` +
      `Sage "Moment, ich schaue nach dem Wetter..." und nutze dann das Tool. ` +
      `Das Ergebnis enthält aktuelle Wetterdaten und eine 3-Tage-Vorhersage.` +
      `\n\nWEB-SUCHE: Du hast ein Tool namens "web_search". ` +
      `Nutze es für aktuelle Fakten, Preise, Ereignisse oder alles was aktueller ist als dein Trainingsdaten-Cutoff. ` +
      `Sage "Lass mich das kurz nachschauen..." und nutze dann das Tool.` +
      `\n\nNACHRICHTEN: Du hast ein Tool namens "get_news". ` +
      `Nutze es wenn der User nach aktuellen Nachrichten, News-Headlines oder Neuigkeiten fragt. ` +
      `Sage "Ich prüfe die aktuellen Nachrichten..." und nutze dann das Tool.` +
      `\n\nWIKIPEDIA: Du hast ein Tool namens "get_wikipedia". ` +
      `Nutze es für Faktenwissen, Definitionen, Biographien, Geschichte, Erklärungen — immer wenn der User nach konkretem Wissen fragt ` +
      `(Was ist...? Wer war...? Wie funktioniert...? Erkläre mir...). ` +
      `Sage "Moment, ich schaue das nach..." und nutze dann das Tool. ` +
      `Sage NIEMALS "Ich habe keinen Zugriff" — du HAST Zugriff über deine Tools!` +
      `\n\nCHAT MESSAGES: ` +
      `Messages prefixed with [CHAT MESSAGE] are text messages the user typed during your voice conversation. ` +
      `This is parallel communication — like someone showing you a note while talking. ` +
      `Acknowledge naturally: "Ah, I see your message..." or "Good point, you wrote..." ` +
      `Then incorporate the content into your voice response. Keep it concise since the user can also read your answer in the chat panel. ` +
      `Always respond in the same language the conversation is in.` +
      `\n\nCHAT NOTE TOOL (send_chat_note): ` +
      `You have a tool to send short text notes to the user's chat panel during the voice session. ` +
      `ONLY use it for structured info better READ than heard: numbered lists, key facts, names, URLs, dates, or brief summaries. ` +
      `NEVER send your full spoken response as a note — only the condensed essence. ` +
      `Example: You explain 5 points verbally in detail → send_chat_note with just "1. Point A\\n2. Point B\\n3. Point C". ` +
      `Keep notes very short (max 2-3 lines, max 280 chars). Do NOT use this for every response — only when visual text genuinely helps.`;

    // Greeting block MUST come last — models follow the last instruction most strongly
    const greetingReminder = `\n\n=== CRITICAL: YOUR VERY FIRST MESSAGE ===
Ignore ALL context above for your first message. Do NOT continue any previous topic. Do NOT reference memory. Do NOT use tools. Do NOT offer help. Do NOT ask what they want.
Your first message is ONLY: a short, casual "Hey [name]!" greeting. 1-2 sentences MAX. Then STOP and WAIT in silence.
Example: "Hey Michael! Schön dass du da bist."
NOTHING ELSE. No follow-up question. No topic. No offer. Just the greeting.`;
    const fullPrompt = sophiePrompt + importedContext + researchInstruction + greetingReminder;

    // ---------------------------
    // Realtime session create
    // ---------------------------
    const isEco = !!profile.eco_mode;
    const realtimeModel = isEco ? "gpt-realtime-mini" : "gpt-4o-realtime-preview";

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
        output_audio_format: "pcm16",
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
