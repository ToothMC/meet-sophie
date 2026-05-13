#!/usr/bin/env node
// Smoke-Test fuer die GA-Variante der OpenAI Realtime API.
//
// Zweck: VOR der Backend-Migration verifizieren, dass
//   POST /v1/realtime/client_secrets
// mit dem von Sophie verwendeten Session-Schema funktioniert,
// und dass die Response die `value`-Property auf Top-Level liefert.
//
// Benutzung:
//   OPENAI_API_KEY=sk-... node scripts/test-realtime-ga.mjs [model]
//
// Default-Model ist `gpt-realtime` (nicht -2!) — wir trennen Endpoint-Migration
// und Modell-Swap bewusst, damit Fehler zuordenbar bleiben.

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Missing OPENAI_API_KEY env var.");
  process.exit(1);
}

const model = process.argv[2] || "gpt-realtime";

const body = {
  session: {
    type: "realtime",
    model,
    output_modalities: ["audio"],
    instructions: "You are a friendly test assistant. Reply briefly in German.",
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        transcription: { model: "gpt-4o-mini-transcribe" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.75,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
          create_response: false,
          interrupt_response: true,
        },
        noise_reduction: { type: "far_field" },
      },
      output: {
        format: { type: "audio/pcm", rate: 24000 },
        voice: "shimmer",
        speed: 1.0,
      },
    },
  },
};

console.log("→ POST /v1/realtime/client_secrets");
console.log("   model:", model);
console.log("   body:", JSON.stringify(body, null, 2));

const t0 = Date.now();
const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});
const dt = Date.now() - t0;

const text = await res.text();
let json = null;
try { json = JSON.parse(text); } catch { /* keep as text */ }

console.log(`\n← ${res.status} ${res.statusText} (${dt}ms)`);
if (!res.ok) {
  console.error("Body:", text);
  process.exit(2);
}

console.log("Top-level keys:", Object.keys(json || {}));
console.log("value present?", typeof json?.value === "string", json?.value ? `(prefix=${json.value.slice(0, 4)}...)` : "");
console.log("expires_at:", json?.expires_at);
console.log("session.model:", json?.session?.model);
console.log("session.audio keys:", json?.session?.audio ? Object.keys(json.session.audio) : null);
console.log("\nOK — Endpoint funktioniert.");
