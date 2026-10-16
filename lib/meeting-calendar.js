// lib/meeting-calendar.js — Folgetermine aus Meetings: Konfliktpruefung + direkter Eintrag
//
// Ablauf (Live alle 2 Min via ?action=schedule_check, einmal nach dem Report):
//   1. Kalender verbunden (Google + calendar-Scope)? Sonst: nichts tun, kein LLM-Call.
//   2. AI (gpt-4o-mini) erkennt Folgetermine im Transkript: "proposed" | "agreed".
//      Datum kommt als YYYY-MM-DD aus einer vorberechneten Datums-Tabelle,
//      Uhrzeit als HH:MM. Zeitzone = die des Users (Header X-Sophie-Timezone); Google bekommt
//      lokale Zeit + timeZone (toGoogleDateTime), nie einen selbst gerechneten Offset.
//   3. proposed → Konfliktpruefung, bei Konflikt stiller Hinweis (einmal pro Slot).
//      agreed   → Event direkt anlegen (einmal pro Meeting + Startzeit), ohne Uhrzeit nur Hinweis.
//
// Idempotenz: meeting_calendar_items UNIQUE(meeting_id, kind, slot_key). Die Zeile wird
// VOR dem Google-Aufruf angelegt (ON CONFLICT DO NOTHING) — nur wer sie anlegt, handelt.
//
// Billing: Kosten NUR via trackCost (intern). Nichts fliesst in analysis_cost_usd →
// keine zusaetzliche Token-Abbuchung beim Nutzer.

import { getValidToken } from './google-token.js';
import { fetchBusyEvents, calendarWrite } from './calendar-fetch.js';
import { getAdapter } from './ai/adapters/index.js';
import { trackCost } from './ai/cost-tracker.js';
import { resolveTimeZone } from './date-context.js';
import {
  buildDetectPrompt, sanitizeAppointments, planSlot, buildCreateParams, findConflict,
  zonedToUtc, localDateStr,
} from './meeting-calendar-core.js';

export { resolveTimeZone };

const TABLE = 'meeting_calendar_items';
const DETECT_MODEL = 'gpt-4o-mini';
const MAX_TRANSCRIPT_CHARS = 6000;
const EARLIER_CONTEXT_CHARS = 800;

// ── Zugriff ───────────────────────────────────────────────────────────────

/** Google verbunden UND calendar-Scope erteilt? (Contacts/Gmail allein reichen nicht.) */
export async function hasCalendarAccess(supabase, userId) {
  try {
    const { data } = await supabase.from('user_integrations')
      .select('scopes')
      .eq('user_id', userId).eq('provider', 'google').eq('is_active', true)
      .maybeSingle();
    return !!data && (data.scopes || []).some(s => typeof s === 'string' && s.includes('calendar'));
  } catch (_) {
    return false;
  }
}

/** Alle Kalender-Items eines Meetings. null = Tabelle nicht verfuegbar (Feature aus). */
export async function loadMeetingCalendarItems(supabase, meetingId) {
  const { data, error } = await supabase.from(TABLE)
    .select('id, kind, slot_key, start_at, end_at, slot_date, status, google_event_id, event_title, conflict_title, source, created_at')
    .eq('meeting_id', meetingId)
    .order('created_at');
  if (error) {
    console.warn('[meeting-calendar] load items failed (feature off):', error.message);
    return null;
  }
  return data || [];
}

/** Item → Client-Notice (Texte baut das UI in der UI-Sprache). */
export function toNotice(row, extra = {}) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    start_at: row.start_at,
    end_at: row.end_at,
    slot_date: row.slot_date,
    event_title: row.event_title,
    conflict_title: row.conflict_title,
    ...extra,
  };
}

// ── AI-Erkennung ──────────────────────────────────────────────────────────

async function detectAppointments({ userId, title, meetingDate, tz, items, earlier, transcript, routingReason }) {
  const prompt = buildDetectPrompt({ title, meetingDate, tz, items, earlier, transcript });
  const adapter = getAdapter('openai');
  const resp = await adapter.complete({
    messages: [{ role: 'system', content: prompt }],
    model: DETECT_MODEL, maxTokens: 300, temperature: 0.1, json: true,
  });
  // Intern tracken — NICHT in analysis_cost_usd (kein User-Billing)
  trackCost({
    userId,
    provider: resp.provider || 'openai',
    model: resp.model || DETECT_MODEL,
    inputTokens: resp.usage?.inputTokens || 0,
    outputTokens: resp.usage?.outputTokens || 0,
    costUsd: resp.usage?.costUsd || 0,
    latencyMs: resp.latencyMs || 0,
    routingReason,
  }).catch(() => {});
  let parsed = null;
  try { parsed = JSON.parse(resp.content || '{}'); } catch (_) { parsed = null; }
  return sanitizeAppointments(parsed);
}

// ── Verarbeitung ──────────────────────────────────────────────────────────

const EVENT_TEXTS = {
  de: { fallbackTitle: 'Folgetermin', description: t => `Von Sophie aus Meeting „${t}“ eingetragen` },
  en: { fallbackTitle: 'Follow-up meeting', description: t => `Added by Sophie from meeting "${t}"` },
  fr: { fallbackTitle: 'Réunion de suivi', description: t => `Ajouté par Sophie depuis la réunion « ${t} »` },
};

/** Claim: legt Zeile an, wenn (meeting, kind, slot) neu ist. Gibt die neue Zeile oder null zurueck. */
async function claimItem(supabase, row) {
  const { data, error } = await supabase.from(TABLE)
    .upsert(row, { onConflict: 'meeting_id,kind,slot_key', ignoreDuplicates: true })
    .select();
  if (error) {
    console.warn('[meeting-calendar] claim failed:', error.message);
    return null;
  }
  return data?.[0] || null;
}

async function updateItem(supabase, id, fields) {
  const { data, error } = await supabase.from(TABLE)
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id).select().maybeSingle();
  if (error) console.warn('[meeting-calendar] update failed:', error.message);
  return data;
}

async function processAppointments({ supabase, userId, meeting, items, appointments, tz, language, source }) {
  const notices = [];
  const now = Date.now();
  const zone = resolveTimeZone(tz);
  const todayLocal = localDateStr(new Date(now), zone);
  const lang = EVENT_TEXTS[language] ? language : 'en';
  const eventTitle = (meeting.title || '').trim() || EVENT_TEXTS[lang].fallbackTitle;
  const ownEventIds = new Set(items.filter(i => i.google_event_id).map(i => i.google_event_id));
  let token = null;
  const getToken = async () => (token = token || await getValidToken(userId, 'google'));

  for (const a of appointments) {
    // ── Ohne Uhrzeit ──
    if (!a.time) {
      if (a.status !== 'agreed' || a.date < todayLocal) continue;
      const bookedThatDay = items.some(i => i.kind === 'booking' && i.start_at && i.status === 'created'
        && localDateStr(new Date(i.start_at), zone) === a.date);
      if (bookedThatDay) continue;
      const row = await claimItem(supabase, {
        meeting_id: meeting.id, user_id: userId, kind: 'time_open', slot_key: a.date,
        slot_date: a.date, status: 'noted', event_title: eventTitle, source,
      });
      if (row) { items.push(row); notices.push(toNotice(row)); }
      continue;
    }

    // Slot in der Zeitzone des Users (Google bekommt lokale Zeit + timeZone)
    const slot = planSlot(a, zone);
    if (!slot || slot.start.getTime() < now - 5 * 60 * 1000) continue; // ungueltig / Vergangenheit

    // ── Vorgeschlagen → Konfliktpruefung ──
    if (a.status === 'proposed') {
      if (items.some(i => i.kind === 'booking' && i.slot_key === slot.slotKey)) continue;
      const row = await claimItem(supabase, {
        meeting_id: meeting.id, user_id: userId, kind: 'check', slot_key: slot.slotKey,
        start_at: slot.start.toISOString(), end_at: slot.end.toISOString(), status: 'pending', source,
      });
      if (!row) continue;
      items.push(row);
      const t = await getToken();
      if (!t) continue;
      const busy = await fetchBusyEvents(t, slot.start, slot.end);
      if (busy === null) continue; // Kalender nicht lesbar → still bleiben, nie "frei" behaupten
      const conflict = findConflict(busy, slot, zone, ownEventIds);
      const updated = await updateItem(supabase, row.id, conflict !== null
        ? { status: 'conflict', conflict_title: conflict.slice(0, 120) }
        : { status: 'free' });
      if (conflict !== null && updated) notices.push(toNotice(updated));
      continue;
    }

    // ── Vereinbart → direkt eintragen ──
    const row = await claimItem(supabase, {
      meeting_id: meeting.id, user_id: userId, kind: 'booking', slot_key: slot.slotKey,
      start_at: slot.start.toISOString(), end_at: slot.end.toISOString(), status: 'pending',
      event_title: eventTitle, source,
    });
    if (!row) continue; // schon eingetragen (oder rueckgaengig gemacht) → nie doppelt
    items.push(row);

    let conflict = null;
    const t = await getToken();
    if (t) {
      const busy = await fetchBusyEvents(t, slot.start, slot.end);
      conflict = findConflict(busy, slot, zone, ownEventIds);
    }

    const created = await calendarWrite(userId, 'create', buildCreateParams(slot, {
      title: eventTitle,
      description: EVENT_TEXTS[lang].description(eventTitle),
    }));
    if (!created.success || !created.event?.id) {
      // Kein Retry: bei Timeout koennte das Event trotzdem existieren → lieber nie doppelt.
      console.warn(`[meeting-calendar] create failed for ${meeting.id} @ ${slot.slotKey}:`, created.error);
      await updateItem(supabase, row.id, { status: 'failed' });
      continue;
    }
    ownEventIds.add(created.event.id);
    const updated = await updateItem(supabase, row.id, {
      status: 'created', google_event_id: created.event.id,
      conflict_title: conflict ? conflict.slice(0, 120) : null,
    });
    if (updated) Object.assign(row, updated);

    // Verschoben? Eigenen alten Eintrag dieses Meetings entfernen.
    let replacedId = null;
    if (a.replaces) {
      const oldKey = zonedToUtc(a.replaces.date, a.replaces.time, zone).toISOString();
      const old = items.find(i => i.kind === 'booking' && i.slot_key === oldKey && i.status === 'created' && i.id !== row.id);
      if (old?.google_event_id) {
        const del = await calendarWrite(userId, 'delete', { eventId: old.google_event_id });
        if (del.success) {
          await updateItem(supabase, old.id, { status: 'replaced' });
          old.status = 'replaced';
          replacedId = old.id;
        }
      }
    }
    notices.push(toNotice(row, replacedId ? { replaced_id: replacedId } : {}));
  }
  return notices;
}

// ── Oeffentliche Einstiegspunkte ──────────────────────────────────────────

/**
 * Live-Check ueber neue Segmente seit sinceIndex.
 * @returns {{ skipped?: string, notices: Array, next_segment_index: number|null }}
 */
export async function runLiveScheduleCheck({ supabase, userId, meeting, sinceIndex, tz, language }) {
  const items = await loadMeetingCalendarItems(supabase, meeting.id);
  if (items === null) return { skipped: 'feature_unavailable', notices: [], next_segment_index: null };
  if (!(await hasCalendarAccess(supabase, userId))) return { skipped: 'no_calendar', notices: [], next_segment_index: null };

  const since = Number.isInteger(sinceIndex) ? sinceIndex : -1;
  const { data: segments } = await supabase.from('meeting_segments')
    .select('segment_index, transcript')
    .eq('meeting_id', meeting.id)
    .gt('segment_index', since)
    .order('segment_index');
  if (!segments?.length) return { skipped: 'no_new_segments', notices: [], next_segment_index: since };
  const nextIndex = segments[segments.length - 1].segment_index;

  const transcript = segments.map(s => s.transcript || '').filter(Boolean).join(' ').trim();
  if (!transcript) return { skipped: 'empty_transcript', notices: [], next_segment_index: nextIndex };

  let earlier = '';
  if (since >= 0) {
    const { data: prev } = await supabase.from('meeting_segments')
      .select('transcript')
      .eq('meeting_id', meeting.id)
      .lte('segment_index', since)
      .order('segment_index', { ascending: false })
      .limit(2);
    earlier = (prev || []).reverse().map(s => s.transcript || '').join(' ').trim().slice(-EARLIER_CONTEXT_CHARS);
  }

  const meetingDate = new Date(meeting.started_at || meeting.created_at || Date.now());
  const appointments = await detectAppointments({
    userId, title: meeting.title, meetingDate, tz,
    items,
    earlier, transcript: transcript.slice(-MAX_TRANSCRIPT_CHARS),
    routingReason: 'meeting_schedule_check',
  });
  if (!appointments.length) return { notices: [], next_segment_index: nextIndex };

  const notices = await processAppointments({ supabase, userId, meeting, items, appointments, tz, language, source: 'live' });
  console.log(`[meeting-calendar] ${meeting.id}: ${appointments.length} appointments, ${notices.length} notices`);
  return { notices, next_segment_index: nextIndex };
}

/**
 * Nach-Meeting-Pass (aus generate-report): nur Fallback, wenn live noch nichts
 * eingetragen wurde. Gleiche Idempotenz-Keys → nie doppelt.
 */
export async function runPostMeetingScheduleCheck({ supabase, userId, meetingId, transcriptText, tz, language }) {
  const items = await loadMeetingCalendarItems(supabase, meetingId);
  if (items === null) return;
  if (items.some(i => (i.kind === 'booking' && i.status !== 'failed') || i.kind === 'time_open')) return; // live schon erledigt
  if (!(await hasCalendarAccess(supabase, userId))) return;

  const { data: meeting } = await supabase.from('meetings')
    .select('id, title, started_at, created_at')
    .eq('id', meetingId).eq('user_id', userId).maybeSingle();
  if (!meeting) return;

  const transcript = (transcriptText || '').trim().slice(-MAX_TRANSCRIPT_CHARS);
  if (!transcript) return;

  const meetingDate = new Date(meeting.started_at || meeting.created_at || Date.now());
  const appointments = await detectAppointments({
    userId, title: meeting.title, meetingDate, tz,
    items,
    earlier: '', transcript,
    routingReason: 'meeting_schedule_post',
  });
  if (!appointments.length) return;
  const notices = await processAppointments({ supabase, userId, meeting, items, appointments, tz, language, source: 'report' });
  console.log(`[meeting-calendar] post ${meetingId}: ${appointments.length} appointments, ${notices.length} notices`);
}

/** Rueckgaengig: eigenes Event loeschen, Status 'undone' (wird danach nie neu eingetragen). */
export async function undoBooking({ supabase, userId, itemId }) {
  const { data: row, error } = await supabase.from(TABLE)
    .select('id, kind, status, google_event_id')
    .eq('id', itemId).eq('user_id', userId).maybeSingle();
  if (error || !row) return { ok: false, error: 'not_found' };
  if (row.kind !== 'booking') return { ok: false, error: 'not_a_booking' };
  if (row.status === 'undone' || row.status === 'replaced') return { ok: true, status: row.status };
  if (row.status !== 'created' || !row.google_event_id) return { ok: false, error: 'not_created' };

  const del = await calendarWrite(userId, 'delete', { eventId: row.google_event_id });
  // Vom User bereits manuell geloescht → Ziel erreicht
  if (!del.success && !/not found/i.test(del.error || '')) {
    return { ok: false, error: 'delete_failed' };
  }
  await updateItem(supabase, row.id, { status: 'undone' });
  return { ok: true, status: 'undone' };
}
