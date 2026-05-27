// Smoke tests for lib/unfiltered/tools.js — verifies the realtime
// function-call schemas match what OpenAI Realtime expects. Catches
// silent regressions in tool descriptions (which power Sophie's choice
// of when to invoke them).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TALK_MODE_GATEWAY_TOOL,
  SAVE_THREAD_EVENT_TOOL,
  ANALYZE_RECEIPT_TOOL,
  GET_DAILY_BRIEFING_TOOL,
  getUnfilteredTools,
} from "../../lib/unfiltered/tools.js";

function assertValidFunctionTool(t, name) {
  assert.equal(t.type, "function", `${name}: type=function`);
  assert.equal(typeof t.name, "string");
  assert.ok(t.name.length > 0, `${name}: name non-empty`);
  assert.equal(typeof t.description, "string");
  assert.ok(t.description.length > 30, `${name}: description has meaningful guidance`);
  assert.equal(t.parameters?.type, "object", `${name}: parameters.type=object`);
  assert.equal(typeof t.parameters?.properties, "object", `${name}: has properties`);
}

test("TALK_MODE_GATEWAY_TOOL — schema valid", () => {
  assertValidFunctionTool(TALK_MODE_GATEWAY_TOOL, "enable_unfiltered_mode");
  assert.equal(TALK_MODE_GATEWAY_TOOL.name, "enable_unfiltered_mode");
  assert.deepEqual(TALK_MODE_GATEWAY_TOOL.parameters.required, ["reason"]);
});

test("TALK_MODE_GATEWAY_TOOL — description teaches consent + restraint", () => {
  const d = TALK_MODE_GATEWAY_TOOL.description.toLowerCase();
  assert.match(d, /ja|yes/, "mentions explicit confirmation");
  assert.match(d, /nie|never|nicht ungefragt/i, "warns against unsolicited use");
});

test("SAVE_THREAD_EVENT_TOOL — required = people/what/sophie_take", () => {
  assertValidFunctionTool(SAVE_THREAD_EVENT_TOOL, "save_thread_event");
  assert.deepEqual(SAVE_THREAD_EVENT_TOOL.parameters.required, ["people", "what", "sophie_take"]);
  assert.equal(SAVE_THREAD_EVENT_TOOL.parameters.properties.people.type, "array");
});

test("ANALYZE_RECEIPT_TOOL — required = purpose", () => {
  assertValidFunctionTool(ANALYZE_RECEIPT_TOOL, "analyze_receipt");
  assert.deepEqual(ANALYZE_RECEIPT_TOOL.parameters.required, ["purpose"]);
});

test("GET_DAILY_BRIEFING_TOOL — refresh param optional + boolean", () => {
  assertValidFunctionTool(GET_DAILY_BRIEFING_TOOL, "get_daily_briefing");
  assert.equal(GET_DAILY_BRIEFING_TOOL.parameters.properties.refresh.type, "boolean");
  // refresh is intentionally OPTIONAL (no required-list)
  assert.ok(!GET_DAILY_BRIEFING_TOOL.parameters.required || GET_DAILY_BRIEFING_TOOL.parameters.required.length === 0);
});

test("getUnfilteredTools — returns the 3 substate tools, NOT the gateway", () => {
  const tools = getUnfilteredTools();
  assert.equal(tools.length, 3);
  const names = tools.map(t => t.name).sort();
  assert.deepEqual(names, ["analyze_receipt", "get_daily_briefing", "save_thread_event"]);
  // Gateway is talk-mode-only — must NOT be in the substate bundle
  assert.equal(tools.find(t => t.name === "enable_unfiltered_mode"), undefined);
});

test("All tool names are unique across the module", () => {
  const all = [TALK_MODE_GATEWAY_TOOL, SAVE_THREAD_EVENT_TOOL, ANALYZE_RECEIPT_TOOL, GET_DAILY_BRIEFING_TOOL];
  const names = all.map(t => t.name);
  assert.equal(new Set(names).size, names.length, "no duplicate tool names");
});
