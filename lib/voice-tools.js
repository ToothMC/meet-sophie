// lib/voice-tools.js — which voice tools the CLIENT really provides per surface and mode.
//
// Must mirror talk/index.html (session.update tool lists) and meeting/index.html. The prompt
// may only describe these tools (grounding audit 16.10.2026: brainstorm, pitch and meeting were
// told they had "full access to the calendar" without having the tool).
//
//   Talk page, no mode   → full tool set (calendar, mail, contacts, web, maps, council, …)
//   Talk page, pitch     → signal_pitch_report + send_chat_note (demo: send_chat_note only)
//   Talk page, brainstorm/meeting → send_chat_note
//   Meeting page (/meeting) → no tools
//   + recall_memory wherever shared memory is enabled (never in xi)

export function voiceToolPlan({ onMeetingPage = false, sessionMode = null, pitchDemo = false, recallEnabled = false } = {}) {
  const hasFullTools = !onMeetingPage && !sessionMode;
  const limitedTools = onMeetingPage ? []
    : sessionMode === "salespitch" ? (pitchDemo ? ["send_chat_note"] : ["signal_pitch_report", "send_chat_note"])
    : ["send_chat_note"];
  if (recallEnabled && sessionMode !== "extra_intelligence") limitedTools.push("recall_memory");
  return { hasFullTools, limitedTools };
}
