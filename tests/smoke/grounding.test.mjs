// Scenario tests for the grounding audit (16.10.2026). They run in CI without network or
// API keys and check what Sophie is TOLD — date, time zone, tools, calendar coverage,
// current facts, location — for every surface and mode. Each test names the real
// incident or audit finding it guards against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildDateBlock, wholeDayWindow, germanToday, longToday } from "../../lib/date-context.js";
import { formatCalendarContext, toGoogleDateTime } from "../../lib/calendar-format.js";
import {
  limitedToolsBlock, CURRENT_FACTS_RULE, LOCATION_RULE, dateAnchorRule,
  CALENDAR_FOOTER_NO_TOOL, CALENDAR_FOOTER_WITH_TOOL, CALENDAR_PRIMARY_ONLY,
} from "../../lib/grounding-texts.js";
import { voiceToolPlan } from "../../lib/voice-tools.js";
import { buildSophiePrompt } from "../../lib/sophie-core.js";
import { buildAdvisorPrompt } from "../../lib/ai/council.js";

const NOW = new Date("2026-10-16T06:32:00Z"); // Friday 09:32 in Cyprus
const TZ = "Asia/Nicosia";
const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

// ── Scenario: "Was ist nächster Freitag?" (incident: 20./18./23. Oktober) ──
test("next Friday is in the date list as 23.10., not computed by the model", () => {
  const block = buildDateBlock(TZ, NOW);
  assert.match(block, /Friday, 16 October 2026/);
  assert.match(block, /Fri 23\.10\./);
  assert.match(block, /never calculate them yourself/);
});

// ── Scenario: "Habe ich am 23.10. einen Termin?" (incident: 7-day window ended 09:32) ──
test("calendar covers whole days and lists 23.10. 10:00", () => {
  const w = wholeDayWindow(TZ, 14, NOW);
  const text = formatCalendarContext([
    { id: "m", title: "Folgemeeting", start: "2026-10-23T10:00:00+03:00", end: "2026-10-23T11:00:00+03:00", allDay: false },
  ], "de", { ...w, tz: TZ });
  assert.match(text, /Fri 23\.10\. 10:00-11:00: Folgemeeting/);
});

// ── Scenario: appointment created by Sophie (incident: 10:00 became 11:00 in Cyprus) ──
test("events are written in the user's time zone, model offsets ignored", () => {
  assert.deepEqual(toGoogleDateTime("2026-10-23T10:00:00+02:00", TZ), { dateTime: "2026-10-23T10:00:00", timeZone: TZ });
});

// ── Audit P1-1: tools on paper only ──
test("only Talk gets the full tool set; other modes get an honest list", () => {
  assert.equal(voiceToolPlan({}).hasFullTools, true);
  for (const mode of ["brainstorm", "meeting", "salespitch"]) {
    const plan = voiceToolPlan({ sessionMode: mode });
    assert.equal(plan.hasFullTools, false, mode);
    assert.ok(plan.limitedTools.includes("send_chat_note"), mode);
  }
  assert.deepEqual(voiceToolPlan({ sessionMode: "salespitch" }).limitedTools, ["signal_pitch_report", "send_chat_note"]);
  assert.deepEqual(voiceToolPlan({ sessionMode: "salespitch", pitchDemo: true }).limitedTools, ["send_chat_note"]);
  assert.deepEqual(voiceToolPlan({ onMeetingPage: true, sessionMode: "meeting" }), { hasFullTools: false, limitedTools: [] });
  assert.deepEqual(voiceToolPlan({ onMeetingPage: true, sessionMode: "meeting", recallEnabled: true }).limitedTools, ["recall_memory"]);
  assert.ok(!voiceToolPlan({ sessionMode: "extra_intelligence", recallEnabled: true }).limitedTools.includes("recall_memory"));
});

test("the limited-tools text says what Sophie cannot do and forbids pretending", () => {
  const t = limitedToolsBlock(["send_chat_note"]);
  assert.match(t, /cannot check the calendar, emails, contacts, the web/);
  assert.match(t, /Never claim you looked something up that you did not/);
  assert.match(limitedToolsBlock([]), /TOOLS IN THIS MODE: none\./);
});

test("the voice session uses the tool plan and never promises calendar tools outside Talk", () => {
  const s = src("api/session.js");
  assert.match(s, /voiceToolPlan\(\{ onMeetingPage, sessionMode/);
  for (const v of ["calendarToolInstruction", "contactsToolInstruction", "gmailToolInstruction", "mapsToolInstruction"]) {
    assert.match(s, new RegExp(`const ${v} = hasFullTools &&`), v);
  }
  assert.doesNotMatch(s, /sessionMode === "meeting";\s*\n\s*const toolInstructions/); // old "meeting = full tools"
});

test("a calendar without a tool (chat, other modes) does not tell Sophie to use one", () => {
  const w = wholeDayWindow(TZ, 14, NOW);
  const noTool = formatCalendarContext([], "de", { ...w, tz: TZ, withTool: false });
  assert.ok(noTool.includes(CALENDAR_FOOTER_NO_TOOL));
  assert.ok(!noTool.includes(CALENDAR_FOOTER_WITH_TOOL));
  assert.match(src("lib/server-prompt.js"), /withTool: false/);
  assert.match(src("api/meeting.js"), /withTool: false/);
});

// ── Audit P1-2: only the main calendar is visible ──
test("calendar block says 'main calendar only' when other calendars are not readable", () => {
  const w = wholeDayWindow(TZ, 14, NOW);
  const text = formatCalendarContext([], "de", { ...w, tz: TZ, primaryOnly: true });
  assert.ok(text.includes(CALENDAR_PRIMARY_ONLY));
  assert.match(src("api/oauth-google.js"), /calendar\.calendarlist\.readonly/);
});

// ── Audit P1-3: time references without a date anchor ──
test("memory extraction, meeting analysis and reports are anchored to today in the user's zone", () => {
  const rule = dateAnchorRule(longToday(TZ, NOW), TZ);
  assert.match(rule, /TODAY: Friday, 16 October 2026 \(user's time zone Asia\/Nicosia\)/);
  assert.match(rule, /never relative/);
  assert.match(src("api/memory-update.js"), /dateAnchorRule\(longToday\(timeZoneFromRequest\(req\)\)/);
  assert.match(src("api/meeting.js"), /dateAnchorRule\(longToday\(timeZoneFromRequest\(req\)\)/);
  assert.match(src("api/ai/generate-report.js"), /localeToday\(userTz, dateLocale\)/);
});

// ── Audit P1-4: current facts ──
test("every Sophie prompt (voice and chat) carries the current-facts rule", () => {
  for (const channel of ["voice", "chat"]) {
    for (const sessionMode of [null, "brainstorm", "meeting", "salespitch"]) {
      const p = buildSophiePrompt({ tier: "partner", sessionMode, channel, language: "de" });
      assert.ok(p.includes(CURRENT_FACTS_RULE), `${channel}/${sessionMode}`);
    }
  }
  assert.ok(!buildSophiePrompt({ sessionMode: "extra_intelligence" }).includes(CURRENT_FACTS_RULE)); // xi keeps its own prompt
});

// ── Audit P2-5: location ──
test("location rule is present where weather/places tools exist", () => {
  assert.match(LOCATION_RULE, /never assume a city/);
  assert.match(src("api/session.js"), /LOCATION_RULE/);
  assert.match(src("api/chat.js"), /LOCATION_RULE/);
  assert.match(src("api/meeting.js"), /LOCATION_RULE/);
});

// ── Audit P2-7: other contacts ──
test("other-contacts search only requests allowed fields", () => {
  const s = src("lib/contacts-fetch.js");
  assert.match(s, /OTHER_CONTACT_FIELDS = 'names,emailAddresses,phoneNumbers'/);
  const other = s.slice(s.indexOf("async function searchOtherContacts("), s.indexOf("async function searchOtherContacts(") + 300);
  assert.match(other, /readMask: OTHER_CONTACT_FIELDS/);
});

// ── Audit P2-8: council ──
test("council advisors get today's date", () => {
  const msgs = buildAdvisorPrompt({ question: "Soll ich das Angebot jetzt senden?", timeZone: TZ });
  assert.match(msgs[1].content, new RegExp(`Heute ist ${germanToday(TZ)}`));
});

// ── Audit P2-9: xi ──
test("xi research is anchored to today's date", () => {
  assert.match(src("api/extra-intelligence/research.js"), /researchDateLine\(longToday\(timeZoneFromRequest\(req\)\)\)/);
});

// ── Time zone reaches the server from every page that talks to Sophie ──
test("all pages send the browser time zone", () => {
  for (const page of ["talk/index.html", "meeting/index.html", "app/index.html", "index.html", "extra-intelligence/index.html"]) {
    assert.match(src(page), /X-Sophie-Timezone|time_zone: \(\(\) =>/, page);
  }
});
