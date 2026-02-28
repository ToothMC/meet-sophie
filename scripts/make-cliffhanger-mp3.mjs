// scripts/make-cliffhanger-mp3.mjs
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Missing OPENAI_API_KEY in environment.");
  process.exit(1);
}

const client = new OpenAI({ apiKey });

// ✅ Dein finaler Satz (ohne Punkt, wie du willst)
const TEXT = "Stay with me";

const OUT_DIR = path.join(process.cwd(), "public", "audio");
const OUT_FILE = path.join(OUT_DIR, "cliffhanger.mp3");

fs.mkdirSync(OUT_DIR, { recursive: true });

// TTS: /v1/audio/speech
// Modelle: gpt-4o-mini-tts, tts-1, tts-1-hd
// Voice: shimmer
const resp = await client.audio.speech.create({
  model: "gpt-4o-mini-tts",
  voice: "shimmer",
  input: TEXT,
  response_format: "mp3",
});

const arrayBuffer = await resp.arrayBuffer();
fs.writeFileSync(OUT_FILE, Buffer.from(arrayBuffer));

console.log("✅ Wrote:", OUT_FILE);
