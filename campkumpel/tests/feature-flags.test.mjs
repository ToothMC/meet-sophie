// tests/feature-flags.test.mjs — Smoke-Tests der Flag-Auflösung
// Läuft mit `node --test`, ohne Test-Framework — wie in Meet-Sophie.

import test from "node:test";
import assert from "node:assert/strict";

import {
  FLAGS,
  isEnabled,
  resolveFlags,
  mvpFlags,
  envVarName,
} from "../lib/feature-flags.js";

// Leeres env übergeben, damit die Tests nicht von der Shell abhängen.
const noEnv = { env: {} };

test("jedes Flag hat default und summary", () => {
  for (const [name, def] of Object.entries(FLAGS)) {
    assert.equal(typeof def.default, "boolean", `${name}.default`);
    assert.ok(def.summary?.length > 0, `${name}.summary`);
    // Abgeschaltete Flags brauchen eine Begründung — sonst weiß in sechs
    // Monaten niemand mehr, ob "aus" Absicht oder Versehen war.
    if (def.default === false) {
      assert.ok(def.note?.length > 0, `${name}.note fehlt`);
    }
  }
});

test("MVP-Flags sind genau die neun aus der Spezifikation", () => {
  assert.deepEqual(mvpFlags().sort(), [
    "chat_text",
    "feedback",
    "live_research",
    "memory_user",
    "memory_vehicle",
    "travel_profile",
    "trip_context",
    "vehicle_documents",
    "vehicle_profile",
  ]);
});

test("unbekanntes Flag liefert false statt zu werfen", () => {
  assert.equal(isEnabled("gibt_es_nicht", noEnv), false);
});

test("Default greift ohne Overrides", () => {
  assert.equal(isEnabled("chat_text", noEnv), true);
  assert.equal(isEnabled("voice", noEnv), false);
});

test("Umgebungsvariable schlägt Default", () => {
  const env = { [envVarName("voice")]: "on" };
  assert.equal(isEnabled("voice", { env }), true);

  const off = { [envVarName("chat_text")]: "off" };
  assert.equal(isEnabled("chat_text", { env: off }), false);
});

test("Organisation schlägt Umgebungsvariable", () => {
  const env = { [envVarName("rental_context")]: "off" };
  assert.equal(isEnabled("rental_context", { env, org: { rental_context: true } }), true);
});

test("Nutzer schlägt Organisation", () => {
  assert.equal(
    isEnabled("voice", { ...noEnv, org: { voice: true }, user: { voice: false } }),
    false,
  );
});

test("unbrauchbarer Override wird ignoriert, nicht als false gewertet", () => {
  // "vielleicht" ist kein Bool. Das Flag muss auf seinem Default bleiben,
  // sonst schaltet ein Tippfehler in der DB ein Feature ab.
  assert.equal(isEnabled("chat_text", { ...noEnv, user: { chat_text: "vielleicht" } }), true);
  assert.equal(isEnabled("chat_text", { ...noEnv, user: { chat_text: null } }), true);
});

test("Zahl- und Stringformen werden erkannt", () => {
  for (const on of [true, 1, "1", "on", "true", "YES", "enabled"]) {
    assert.equal(isEnabled("voice", { ...noEnv, user: { voice: on } }), true, `on: ${on}`);
  }
  for (const off of [false, 0, "0", "off", "false", "NO", "disabled"]) {
    assert.equal(isEnabled("chat_text", { ...noEnv, user: { chat_text: off } }), false, `off: ${off}`);
  }
});

test("resolveFlags liefert für jedes Flag einen Boolean", () => {
  const resolved = resolveFlags({ ...noEnv, org: { rental_context: true } });
  assert.deepEqual(Object.keys(resolved).sort(), Object.keys(FLAGS).sort());
  for (const [name, value] of Object.entries(resolved)) {
    assert.equal(typeof value, "boolean", name);
  }
  assert.equal(resolved.rental_context, true);
  assert.equal(resolved.fleet_dashboard, false);
});
