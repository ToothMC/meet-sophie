// Meeting follow-up appointments (lib/meeting-calendar-core.js).
// Guards against 16.10.2026: a 10:00 appointment for a user in Cyprus was written with
// +02:00 and showed up at 11:00. Follow-ups must reach Google as local time + the
// user's time zone, and conflicts must be compared in the user's time zone.
// Runs in CI without node_modules (core module has no npm imports).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  planSlot, buildCreateParams, findConflict, buildDetectPrompt, sanitizeAppointments, zonedToUtc,
} from "../../lib/meeting-calendar-core.js";
import { toGoogleDateTime } from "../../lib/calendar-format.js";

const CY = "Asia/Nicosia";

test("agreed 10:00 in Cyprus goes to Google as 10:00 Asia/Nicosia, not with a guessed offset", () => {
  const slot = planSlot({ date: "2026-10-20", time: "10:00", duration_minutes: null }, CY);
  assert.deepEqual(slot.googleStart, { dateTime: "2026-10-20T10:00:00", timeZone: CY });
  assert.deepEqual(slot.googleEnd, { dateTime: "2026-10-20T11:00:00", timeZone: CY });
  assert.equal(slot.start.toISOString(), "2026-10-20T07:00:00.000Z");
  assert.equal(slot.end.toISOString(), "2026-10-20T08:00:00.000Z");

  const params = buildCreateParams(slot, { title: "Projekt Falke Weekly", description: "x" });
  assert.equal(params.timeZone, CY);
  assert.doesNotMatch(params.start, /[+-]\d{2}:\d{2}$|Z$/);
  // createCalendarEvent turns these params into exactly this Google body:
  assert.deepEqual(toGoogleDateTime(params.start, params.timeZone), { dateTime: "2026-10-20T10:00:00", timeZone: CY });
  assert.deepEqual(toGoogleDateTime(params.end, params.timeZone), { dateTime: "2026-10-20T11:00:00", timeZone: CY });
});

test("Berlin around the DST switch on 25.10.: idempotency key is the right instant", () => {
  assert.equal(planSlot({ date: "2026-10-23", time: "10:00" }, "Europe/Berlin").slotKey, "2026-10-23T08:00:00.000Z");
  assert.equal(planSlot({ date: "2026-10-26", time: "10:00" }, "Europe/Berlin").slotKey, "2026-10-26T09:00:00.000Z");
  assert.equal(zonedToUtc("2026-10-25", "10:00", "Europe/Berlin").toISOString(), "2026-10-25T09:00:00.000Z");
  const d = planSlot({ date: "2026-10-20", time: "10:00", duration_minutes: 30 }, "Europe/Berlin");
  assert.equal(d.googleEnd.dateTime, "2026-10-20T10:30:00");
});

test("conflict check compares in the user's time zone", () => {
  // Saved with +02:00 → 11:00–12:00 in Cyprus
  const events = [{ id: "e1", title: "Zahnarzt", start: "2026-10-20T10:00:00+02:00", end: "2026-10-20T11:00:00+02:00", allDay: false }];
  const at11 = planSlot({ date: "2026-10-20", time: "11:00" }, CY);
  const at10 = planSlot({ date: "2026-10-20", time: "10:00" }, CY);
  assert.equal(findConflict(events, at11, CY), "Zahnarzt");
  assert.equal(findConflict(events, at10, CY), null, "back-to-back is not a conflict");
  assert.equal(findConflict(events, at11, CY, new Set(["e1"])), null, "Sophie's own event is not a conflict");
});

test("all-day entries block their own day only", () => {
  const events = [{ id: "u", title: "Urlaub", start: "2026-10-20", end: "2026-10-21", allDay: true }];
  assert.equal(findConflict(events, planSlot({ date: "2026-10-20", time: "15:00" }, CY), CY), "Urlaub");
  assert.equal(findConflict(events, planSlot({ date: "2026-10-21", time: "09:00" }, CY), CY), null);
});

test("prompt anchors dates in the user's time zone; the model only picks from the table", () => {
  const meetingDate = new Date("2026-10-16T06:32:00Z"); // Friday 09:32 in Cyprus
  const p = buildDetectPrompt({
    title: "Projekt Falke Weekly", meetingDate, tz: CY, items: [], earlier: "", transcript: "Next Tuesday at ten?", now: meetingDate,
  });
  assert.match(p, /Meeting date: Friday, 16 October 2026, local time now 09:32, time zone Asia\/Nicosia/);
  assert.match(p, /Fri 2026-10-16 \(meeting day\)/);
  assert.match(p, /Tue 2026-10-20/);
  assert.match(p, /never compute weekdays yourself/);
  assert.match(p, /untrusted meeting audio transcript/);

  // Late evening UTC is already the next day in Cyprus
  const late = buildDetectPrompt({ title: "", meetingDate: new Date("2026-10-16T22:30:00Z"), tz: CY, items: [], transcript: "x" });
  assert.match(late, /Sat 2026-10-17 \(meeting day\)/);
});

test("known appointments are listed in local time", () => {
  const p = buildDetectPrompt({
    title: "", meetingDate: new Date("2026-10-16T06:32:00Z"), tz: CY, transcript: "x",
    items: [
      { kind: "check", start_at: "2026-10-20T07:00:00.000Z" },
      { kind: "booking", status: "created", start_at: "2026-10-22T12:00:00.000Z" },
      { kind: "booking", status: "replaced", start_at: "2026-10-21T12:00:00.000Z" },
      { kind: "time_open", slot_date: "2026-10-23" },
    ],
  });
  assert.match(p, /- proposed 2026-10-20 10:00/);
  assert.match(p, /- agreed 2026-10-22 15:00/);
  assert.doesNotMatch(p, /2026-10-21 15:00/);
  assert.match(p, /- agreed 2026-10-23 \(no time yet\)/);
});

test("AI answer is format-checked", () => {
  const out = sanitizeAppointments({ appointments: [
    { status: "agreed", date: "2026-10-20", time: "10:00", duration_minutes: 45, replaces: "2026-10-19 09:00" },
    { status: "agreed", date: "20.10.2026", time: "10:00" },
    { status: "maybe", date: "2026-10-20", time: "10:00" },
    { status: "proposed", date: "2026-10-21", time: "25:00" },
  ] });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].replaces, { date: "2026-10-19", time: "09:00" });
  assert.equal(out[1].time, null);
});
