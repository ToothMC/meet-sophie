// lib/grounding-texts.js — prompt texts from the grounding audit (16.10.2026), in one place.
//
// Everything Sophie needs to know about "now, here and her own capabilities" that is not
// date arithmetic (lib/date-context.js). English per project rule; the council and the
// fact-check keep their German prompts, so their date line is German.
// Wording approved by Michael before activation. Scenario tests: tests/smoke/grounding.test.mjs

// ── Tools: Sophie must only claim tools she actually has in this mode ──
const TOOL_LABEL = {
  send_chat_note: "send_chat_note (short note in the chat panel)",
  recall_memory: "recall_memory (look up earlier sessions)",
  signal_pitch_report: "signal_pitch_report (end the pitch and create the report)",
};

/** For modes with a reduced tool set (pitch, brainstorm, meeting, meeting page). */
export function limitedToolsBlock(toolNames = []) {
  const list = toolNames.length ? toolNames.map((t) => TOOL_LABEL[t] || t).join(", ") : "none";
  return `TOOLS IN THIS MODE: ${list}.
You cannot check the calendar, emails, contacts, the web, news, weather or maps in this mode. If the user asks for that, say so briefly and suggest asking you in the normal Talk mode. Never claim you looked something up that you did not.`;
}

// ── Calendar block variants ──
export const CALENDAR_PRIMARY_ONLY = "main calendar only — the user's other calendars are not connected";
export const CALENDAR_FOOTER_WITH_TOOL = "This list is complete only for these days. For any other day, check the calendar tool first — never say a day is free without having checked it.";
export const CALENDAR_FOOTER_NO_TOOL = "This list is complete only for these days. You cannot check the calendar for other days in this conversation — say so instead of guessing, and never say a day is free without having checked it.";

// ── Current facts: training knowledge is old ──
export const CURRENT_FACTS_RULE = `CURRENT FACTS: Your trained knowledge ends in the past. Anything that can change — prices, laws, office holders, results, schedules, opening hours, news, product details — look up with a tool before stating it as current. If you have no such tool in this mode, say that your information may be outdated.`;

// ── Location: never assume a city ──
export const LOCATION_RULE = `LOCATION: You do not know where the user is right now. If the user asks about weather, places or routes without naming a place, ask where — never assume a city. The user's time zone is only a hint, not their location.`;

// ── Date anchor for extraction prompts (memory, meeting analysis) ──
export function dateAnchorRule(todayLong, timeZone) {
  return `TODAY: ${todayLong} (user's time zone ${timeZone}). Write every date or time as an absolute date (e.g. "Tuesday, 20 October 2026, 10:00") — never relative ("next Tuesday", "Friday", "tomorrow").`;
}

// ── German date line for council advisors (their prompts are German) ──
export function councilDateLine(germanToday) {
  return `Heute ist ${germanToday}. Rechne Zeitangaben von diesem Datum aus, nicht von deinem Trainingsstand.`;
}

// ── xi research ──
export function researchDateLine(todayLong) {
  return `Today is ${todayLong}. Interpret "today", "yesterday", "this week" relative to this date.`;
}

// ── Imported history vs. own memory (test 16.10.2026: "ideas from the last brainstorm" went to
//    search_history = imported ChatGPT/Claude chats, found nothing; recall_memory only on 2nd try) ──
export function searchHistoryInstruction(recallEnabled) {
  return recallEnabled
    ? `IMPORTED HISTORY (search_history): only the user's imported chats with other AI assistants (ChatGPT, Claude). For earlier sessions with you — talks, meetings, pitches, brainstorms, chats — always use recall_memory. Before calling a tool, say a short bridge phrase in the user's language.`
    : `IMPORTED HISTORY (search_history): only the user's imported chats with other AI assistants (ChatGPT, Claude). Before calling it, say a short bridge phrase in the user's language.`;
}

// ── Calendar: every entry counts (test 16.10.2026: "danach frei" despite a 20:00 reminder) ──
export const CALENDAR_EVERY_ENTRY_RULE = "Every listed entry counts, including reminders and private entries — never call a time free if an entry falls into it.";

// ── Recall: do not mix sessions into a protocol (test 16.10.2026: a talk item was
//    presented as an open point of the meeting protocol) ──
export const RECALL_SOURCE_RULE = `Session summaries describe what was said in that conversation, not what a protocol or pitch contains. When asked what a protocol, pitch or brainstorm says, use only the lines from that session (same title) and say if a point comes from a different session.`;
