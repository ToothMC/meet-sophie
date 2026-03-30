#!/usr/bin/env node
// tests/sophie-eval.js — Sophie Self-Play Evaluation Runner
// Usage: node tests/sophie-eval.js [--url https://preview.vercel.app] [--persona curious_newcomer]
//
// Runs automated conversations between a Test-User (GPT-4o-mini) and Sophie (Chat API),
// with Claude Sonnet judging each response against personality rules.

import { PERSONAS } from "./eval-personas.js";
import { JUDGE_SYSTEM_PROMPT, buildJudgePrompt, parseJudgeResponse } from "./eval-judge.js";
import { getAdapter } from "../lib/ai/adapters/index.js";

// ── Config ──────────────────────────────────────────────────────────────────
const DEFAULT_URL = "https://meet-sophie-git-feat-personal-919651-michaels-projects-674b8d24.vercel.app";

const args = process.argv.slice(2);
const urlArg = args.find(a => a.startsWith("--url="))?.split("=")[1]
  || args[args.indexOf("--url") + 1]
  || DEFAULT_URL;
const personaFilter = args.find(a => a.startsWith("--persona="))?.split("=")[1]
  || args[args.indexOf("--persona") + 1]
  || null;

const API_BASE = urlArg.replace(/\/$/, "");
const TEST_USER_MODEL = "gpt-4o-mini";
const JUDGE_MODEL = "claude-sonnet-4-6";

// ── Helpers ─────────────────────────────────────────────────────────────────
async function chatAPI(action, body = {}) {
  const res = await fetch(`${API_BASE}/api/chat?action=${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${action} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function generateTestUserMessage(adapter, persona, conversationHistory, turnNumber) {
  // Check for forced messages first
  if (persona.forcedMessages[turnNumber]) {
    return persona.forcedMessages[turnNumber];
  }

  const messages = [
    { role: "system", content: persona.system },
    ...conversationHistory.map(t => ({
      role: t.role === "user" ? "assistant" : "user", // Flip: from test-user perspective, Sophie is the "user"
      content: t.content,
    })),
    { role: "user", content: "Generate your next message as this persona. Keep it natural and short (1-2 sentences max). Return ONLY the message text, nothing else." },
  ];

  const resp = await adapter.complete({
    messages,
    model: TEST_USER_MODEL,
    maxTokens: 150,
    temperature: 0.9,
  });
  return (resp.content || "").trim();
}

async function judgeResponse(adapter, userMessage, sophieResponse, recentHistory) {
  const prompt = buildJudgePrompt(userMessage, sophieResponse, recentHistory);
  const resp = await adapter.complete({
    messages: [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    model: JUDGE_MODEL,
    maxTokens: 300,
    temperature: 0.1,
  });
  return parseJudgeResponse(resp.content || "");
}

// ── Single Persona Run ──────────────────────────────────────────────────────
async function runPersona(persona) {
  const openaiAdapter = getAdapter("openai");
  const anthropicAdapter = getAdapter("anthropic");

  console.log(`\n  ┌─ ${persona.name} (${persona.language}) ─────────────────────`);

  // Start session
  const startData = await chatAPI("start", { language: persona.language });
  const sessionId = startData.session_id;
  const opener = startData.opener;

  const conversationHistory = [{ role: "assistant", content: opener }];
  const results = [];

  // Judge the opener
  const openerJudge = await judgeResponse(anthropicAdapter, "(session start)", opener, []);
  results.push({ turn: 0, role: "opener", sophie: opener, score: openerJudge });
  const scoreIcon = openerJudge.score >= 7 ? "✓" : openerJudge.score >= 4 ? "~" : "✗";
  console.log(`  │ Opener: ${openerJudge.score}/10 ${scoreIcon} — ${openerJudge.reasoning.slice(0, 60)}`);

  // Run turns
  for (let turn = 1; turn <= persona.turns; turn++) {
    try {
      // Generate test user message
      const userMsg = await generateTestUserMessage(openaiAdapter, persona, conversationHistory, turn);
      conversationHistory.push({ role: "user", content: userMsg });

      // Send to Sophie
      const sophieData = await chatAPI("message", {
        session_id: sessionId,
        messages: conversationHistory,
      });

      if (sophieData.limit_reached) {
        console.log(`  │ Turn ${turn}: [LIMIT REACHED]`);
        break;
      }

      const sophieReply = sophieData.reply || "(empty)";
      conversationHistory.push({ role: "assistant", content: sophieReply });

      // Judge Sophie's response (with last 6 messages for context)
      const recent = conversationHistory.slice(-6);
      const judge = await judgeResponse(anthropicAdapter, userMsg, sophieReply, recent);
      results.push({ turn, user: userMsg, sophie: sophieReply, score: judge });

      const icon = judge.score >= 7 ? "✓" : judge.score >= 4 ? "~" : "✗";
      const violations = judge.violations.length ? ` [${judge.violations.join(", ")}]` : "";
      console.log(`  │ Turn ${turn}: ${judge.score}/10 ${icon}${violations}`);
      console.log(`  │   User: "${userMsg.slice(0, 50)}"`);
      console.log(`  │   Sophie: "${sophieReply.slice(0, 60)}"`);

    } catch (err) {
      console.log(`  │ Turn ${turn}: ERROR — ${err.message.slice(0, 80)}`);
      results.push({ turn, error: err.message });
    }
  }

  // Calculate averages
  const scores = results.filter(r => r.score).map(r => r.score.score);
  const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : "N/A";

  // Count violations
  const allViolations = results
    .filter(r => r.score?.violations)
    .flatMap(r => r.score.violations);
  const violationCounts = {};
  allViolations.forEach(v => { violationCounts[v] = (violationCounts[v] || 0) + 1; });

  console.log(`  │`);
  console.log(`  │ Average: ${avg}/10`);
  if (Object.keys(violationCounts).length > 0) {
    console.log(`  │ Violations: ${Object.entries(violationCounts).map(([k, v]) => `${k}(${v})`).join(", ")}`);
  }
  console.log(`  └──────────────────────────────────────────────`);

  return { persona: persona.name, language: persona.language, average: parseFloat(avg) || 0, results, violationCounts };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n═══ Sophie Self-Play Evaluation ═══`);
  console.log(`Endpoint: ${API_BASE}`);
  console.log(`Date: ${new Date().toISOString().slice(0, 16)}`);
  console.log(`Test-User: ${TEST_USER_MODEL} | Judge: ${JUDGE_MODEL}`);

  const personas = personaFilter
    ? PERSONAS.filter(p => p.id === personaFilter)
    : PERSONAS;

  if (personas.length === 0) {
    console.error(`Persona "${personaFilter}" not found. Available: ${PERSONAS.map(p => p.id).join(", ")}`);
    process.exit(1);
  }

  const allResults = [];

  for (const persona of personas) {
    try {
      const result = await runPersona(persona);
      allResults.push(result);
    } catch (err) {
      console.error(`\n  ✗ ${persona.name} FAILED: ${err.message}`);
      allResults.push({ persona: persona.name, average: 0, error: err.message });
    }
  }

  // ── Final Report ──────────────────────────────────────────────────────────
  console.log(`\n═══ RESULTS ═══`);

  const overallScores = allResults.filter(r => r.average > 0).map(r => r.average);
  const overallAvg = overallScores.length
    ? (overallScores.reduce((a, b) => a + b, 0) / overallScores.length).toFixed(1)
    : "N/A";

  for (const r of allResults) {
    const icon = r.average >= 7 ? "✓" : r.average >= 4 ? "~" : "✗";
    console.log(`  ${icon} ${r.persona} (${r.language || "?"}): ${r.average}/10`);
  }

  console.log(`\n  OVERALL: ${overallAvg}/10`);

  // Aggregate violations across all personas
  const totalViolations = {};
  allResults.forEach(r => {
    if (r.violationCounts) {
      Object.entries(r.violationCounts).forEach(([k, v]) => {
        totalViolations[k] = (totalViolations[k] || 0) + v;
      });
    }
  });

  if (Object.keys(totalViolations).length > 0) {
    console.log(`\n  Top Issues:`);
    Object.entries(totalViolations)
      .sort(([, a], [, b]) => b - a)
      .forEach(([violation, count]) => {
        console.log(`    ${count}x ${violation}`);
      });
  }

  console.log(`\n═══════════════\n`);
}

main().catch(err => {
  console.error("Eval failed:", err);
  process.exit(1);
});
