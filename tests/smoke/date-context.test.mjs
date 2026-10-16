// Regression for 2026-10-16: Sophie named wrong dates for "next Friday" and said
// "no appointments on 23.10." although there was one at 10:00 (7-day window ended 09:32).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDateBlock, wholeDayWindow, resolveTimeZone, localMidnightUtc, germanToday } from "../../lib/date-context.js";
import { formatCalendarContext } from "../../lib/calendar-format.js";

const NOW = new Date("2026-10-16T07:32:00Z"); // Friday 09:32 in Berlin

test("date block names today and the next Friday correctly", () => {
  const block = buildDateBlock("Europe/Berlin", NOW);
  assert.match(block, /Friday, 16 October 2026, 09:32/);
  assert.match(block, /Fri 16\.10\. \(today\)/);
  assert.match(block, /Fri 23\.10\./);
  assert.match(block, /Thu 29\.10\./);
  assert.doesNotMatch(block, /Fri 20\.10\.|Fri 18\.10\./);
});

test("calendar window covers whole days, incl. 23.10. 10:00", () => {
  const w = wholeDayWindow("Europe/Berlin", 14, NOW);
  assert.equal(w.timeMin.toISOString(), "2026-10-15T22:00:00.000Z");
  assert.equal(w.timeMax.toISOString(), "2026-10-29T23:00:00.000Z"); // after DST switch on 25.10.
  const meeting = Date.parse("2026-10-23T10:00:00+02:00");
  assert.ok(meeting >= w.timeMin.getTime() && meeting < w.timeMax.getTime());
});

test("calendar block states its period and lists the 23.10. appointment", () => {
  const w = wholeDayWindow("Europe/Berlin", 14, NOW);
  const text = formatCalendarContext([
    { id: "m1", title: "Folgemeeting", start: "2026-10-23T10:00:00+02:00", end: "2026-10-23T11:00:00+02:00", allDay: false },
  ], "de", w);
  assert.match(text, /complete for Fri 16\.10\. to Thu 29\.10\./);
  assert.match(text, /Fri 23\.10\. 10:00-11:00: Folgemeeting/);
  assert.match(text, /never say a day is free without having checked it/);
});

test("truncated list only claims completeness up to the last safe day", () => {
  const w = wholeDayWindow("Europe/Berlin", 14, NOW);
  const text = formatCalendarContext([
    { id: "a", title: "A", start: "2026-10-20T09:00:00+02:00", end: "2026-10-20T10:00:00+02:00", allDay: false },
    { id: "b", title: "B", start: "2026-10-27T09:00:00+01:00", end: "2026-10-27T10:00:00+01:00", allDay: false },
  ], "de", { ...w, truncated: true });
  assert.match(text, /complete for Fri 16\.10\. to Mon 26\.10\./);
  assert.doesNotMatch(text, /: B/);
});

test("time zone fallback and DST-safe midnight", () => {
  assert.equal(resolveTimeZone("Not/AZone"), "Europe/Berlin");
  assert.equal(resolveTimeZone(""), "Europe/Berlin");
  assert.equal(localMidnightUtc(2026, 10, 26, "Europe/Berlin").toISOString(), "2026-10-25T23:00:00.000Z");
  assert.equal(germanToday("Europe/Berlin", NOW), "Freitag, 16.10.2026");
});

// Regression for 2026-10-16 (2): Sophie wrote 10:00+02:00 for a user in Cyprus → 11:00 in
// the calendar, then attributed the calendar time to the meeting protocol.
import { toGoogleDateTime, addMinutesLocal, SOURCE_CONFLICT_RULE } from "../../lib/calendar-format.js";

test("create/update use the user's time zone, model offsets are ignored", () => {
  assert.deepEqual(toGoogleDateTime("2026-10-23T10:00", "Asia/Nicosia"), { dateTime: "2026-10-23T10:00:00", timeZone: "Asia/Nicosia" });
  assert.deepEqual(toGoogleDateTime("2026-10-23T10:00:00+02:00", "Asia/Nicosia"), { dateTime: "2026-10-23T10:00:00", timeZone: "Asia/Nicosia" });
  assert.equal(toGoogleDateTime("2026-10-23T10:00", ""), null); // no tz → caller keeps old behaviour
  assert.deepEqual(addMinutesLocal({ dateTime: "2026-10-23T23:30:00", timeZone: "Asia/Nicosia" }, 60), { dateTime: "2026-10-24T00:30:00", timeZone: "Asia/Nicosia" });
});

test("calendar shows times in the user's time zone and carries the source rule", () => {
  const now = new Date("2026-10-16T06:32:00Z");
  const w = wholeDayWindow("Asia/Nicosia", 14, now);
  const text = formatCalendarContext([
    { id: "x", title: "Folgemeeting", start: "2026-10-23T10:00:00+02:00", end: "2026-10-23T11:00:00+02:00", allDay: false },
  ], "de", { ...w, tz: "Asia/Nicosia" });
  assert.match(text, /Fri 23\.10\. 11:00-12:00: Folgemeeting/); // truthful: that entry IS 11:00 in Cyprus
  assert.ok(text.includes(SOURCE_CONFLICT_RULE));
});
