// api/session.js
import { createClient } from "@supabase/supabase-js";
import { buildSophiePrompt, mapPlanToTier } from "../lib/sophie-core.js";

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
    const sessionMode = ["brainstorm", "meeting"].includes(rawSessionMode) ? rawSessionMode : null;

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
    // Usage / Remaining seconds (für ALLE)
    // ---------------------------
    const { data: usage, error: usageErr } = await supabase
      .from("user_usage")
      .select("free_seconds_total, free_seconds_used, paid_seconds_total, paid_seconds_used, topup_seconds_balance")
      .eq("user_id", user.id)
      .maybeSingle();

    if (usageErr) {
      return res.status(500).json({ error: usageErr.message });
    }

    const freeTotal = usage?.free_seconds_total ?? 120;
    const freeUsed = usage?.free_seconds_used ?? 0;
    const freeRemaining = Math.max(0, freeTotal - freeUsed);

    const paidTotal = usage?.paid_seconds_total ?? 0;
    const paidUsed = usage?.paid_seconds_used ?? 0;
    const paidRemaining = Math.max(0, paidTotal - paidUsed);

    const topupRemaining = Math.max(0, usage?.topup_seconds_balance ?? 0);

    const remaining = freeRemaining + paidRemaining + topupRemaining;

    if (remaining <= 0) {
      const reason = isPremium
      ? "subscription_quota_exhausted"
      : "no_active_subscription";

    return res.status(402).json({
      error: "No remaining time",
      reason,
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
            "occupation, conversation_style, topics_like, topics_avoid, memory_confidence, last_confirmed_at"
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

    const sophiePrompt = buildSophiePrompt({
      tier,
      sessionMode,
      isFirstSession,
      hasHandover: hasHandoverContext,
      handoverContext: hasHandoverContext ? handover : null,
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

    // ---------------------------
    // Realtime session create
    // ---------------------------
    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-realtime",
        voice: "shimmer",
        modalities: ["audio", "text"],
        temperature: 0.85,
        speed: 1.0,
        instructions: sophiePrompt,
        input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
        input_audio_format: "pcm16",
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 400,
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

    return res.status(200).json({
      ...data,
      remaining_seconds: remaining,
      is_premium: isPremium,
      plan: plan,
      mode: mode,
      user_id: user.id,
      preferred_language: preferredLanguage,
      is_first_session: isFirstSession,

      // Soft ending config for frontend
      soft_end_enabled: true,
      soft_end_warning_seconds: softEndWarningSeconds,
      soft_end_summary_seconds: softEndSummarySeconds,
      summary_required_before_cut: true,

      // Helpful info for UI / debug
      free_remaining_seconds: freeRemaining,
      paid_remaining_seconds: paidRemaining,
      topup_remaining_seconds: topupRemaining,
    });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
