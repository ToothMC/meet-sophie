// lib/server-prompt.js — Server-side system prompt builder
// Shared by api/chat.js, api/ai/compare.js, api/ai/challenge.js
// The client NEVER sees or supplies the system prompt.

import { buildSophiePrompt, mapPlanToTier } from "./sophie-core.js";

export async function buildServerSystemPrompt({ supabase, user, sessionMode, brainstormConfig, language, conversationPolicy }) {
  let profile = { first_name: "", preferred_name: "", preferred_addressing: "", preferred_pronoun: "", preferred_language: "en", notes: "", occupation: "", conversation_style: "", topics_like: [], topics_avoid: [], memory_file: "" };
  let rel     = { tone_baseline: "", openness_level: "", emotional_patterns: "", last_interaction_summary: "" };
  let recentSessions = [];
  let isPremium = false;
  let plan = null;
  let importedContext = "";

  if (user) {
    try {
      const [profRes, relRes, subRes, sessRes, importRes] = await Promise.all([
        supabase.from("user_profile").select("first_name,preferred_name,preferred_addressing,preferred_pronoun,preferred_language,notes,occupation,conversation_style,topics_like,topics_avoid,eco_mode,memory_file").eq("user_id", user.id).maybeSingle(),
        supabase.from("user_relationship").select("tone_baseline,openness_level,emotional_patterns,last_interaction_summary,communication_style,thinking_pattern").eq("user_id", user.id).maybeSingle(),
        supabase.from("user_subscriptions").select("is_active,status,plan").eq("user_id", user.id).maybeSingle(),
        supabase.from("user_sessions").select("session_date,emotional_tone,stress_level,closeness_level,short_summary").eq("user_id", user.id).order("session_date", { ascending: false }).limit(5),
        supabase.from("source_connections").select("id").eq("user_id", user.id).eq("status", "active"),
      ]);

      if (profRes.data) {
        profile = {
          first_name: (profRes.data.first_name || "").trim(),
          preferred_name: (profRes.data.preferred_name || "").trim(),
          preferred_addressing: (profRes.data.preferred_addressing || "").trim(),
          preferred_pronoun: (profRes.data.preferred_pronoun || "").trim(),
          preferred_language: (profRes.data.preferred_language || "en").toLowerCase().trim(),
          notes: (profRes.data.notes || "").trim(),
          occupation: (profRes.data.occupation || "").trim(),
          conversation_style: (profRes.data.conversation_style || "").trim(),
          topics_like: Array.isArray(profRes.data.topics_like) ? profRes.data.topics_like : [],
          topics_avoid: Array.isArray(profRes.data.topics_avoid) ? profRes.data.topics_avoid : [],
          eco_mode: !!profRes.data.eco_mode,
          memory_file: (profRes.data.memory_file || "").trim(),
        };
      }
      if (relRes.data) rel = relRes.data;
      if (subRes.data) {
        isPremium = !!(subRes.data.is_active || subRes.data.status === "active");
        plan = subRes.data.plan || null;
      }
      if (Array.isArray(sessRes.data)) recentSessions = sessRes.data;

      // Load imported data from active sources
      if (importRes.data?.length > 0) {
        const sourceIds = importRes.data.map(s => s.id);

        const { data: insights } = await supabase
          .from("source_items")
          .select("summary, extracted_insights, content_type, zone")
          .in("source_id", sourceIds)
          .in("zone", ["B", "C"])
          .limit(30);

        const insightTexts = (insights || [])
          .map(i => {
            if (i.extracted_insights && Object.keys(i.extracted_insights).length > 0) {
              return JSON.stringify(i.extracted_insights);
            }
            return i.summary;
          })
          .filter(t => t && t !== "Import von claude" && t !== "Import von chatgpt" && t.length > 10);

        if (insightTexts.length > 0) {
          importedContext = "\n\nIMPORTIERTER KONTEXT (aus früheren KI-Gesprächen des Users):\n" + insightTexts.slice(0, 20).join("\n");
        } else {
          const { data: rawItems } = await supabase
            .from("source_items")
            .select("raw_content")
            .in("source_id", sourceIds)
            .eq("zone", "A")
            .limit(5);

          const rawTexts = (rawItems || [])
            .map(i => i.raw_content)
            .filter(Boolean)
            .join("\n\n");

          if (rawTexts.length > 0) {
            const titles = rawTexts.split("\n")
              .filter(line => line.startsWith("# ") && line !== "# Untitled")
              .map(line => line.replace("# ", "").trim())
              .filter(t => t.length > 3);

            const userMsgs = rawTexts.split("\n")
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
              importedContext = "\n\nIMPORTIERTER KONTEXT (aus früheren KI-Gesprächen des Users — nutze diese Informationen um den User besser zu verstehen und auf seine Projekte/Themen einzugehen):\n" + parts.join("\n\n");
            }
          }
        }
      }
    } catch (e) {
      console.warn("Context load error:", e?.message);
    }
  }

  const tier = mapPlanToTier(plan, isPremium);

  const isFirstSession =
    (!profile.first_name || profile.first_name.trim() === "") &&
    (!rel.last_interaction_summary || rel.last_interaction_summary.trim() === "");

  const systemPrompt = buildSophiePrompt({
    tier,
    sessionMode,
    isFirstSession,
    hasHandover: false,
    language,
    user: {
      name: (profile.preferred_name || profile.first_name || "").trim(),
      addressing: profile.preferred_addressing,
      pronoun: profile.preferred_pronoun,
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
    channel: "chat",
    brainstormConfig,
    conversationPolicy,
  });

  const fullSystemPrompt = importedContext
    ? systemPrompt + importedContext
    : systemPrompt;

  return { fullSystemPrompt, tier, isPremium, plan, isFirstSession, profile };
}
