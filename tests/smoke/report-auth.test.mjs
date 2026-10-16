// Security fix 16.10.2026: /api/ai/generate-report had no auth — anyone knowing a
// session_id could overwrite another user's report, meeting summary and pitch memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("generate-report requires a login and the session owner", () => {
  const s = src("api/ai/generate-report.js");
  assert.match(s, /if \(!callerId\) return res\.status\(401\)/);
  assert.match(s, /if \(!ownerRow \|\| ownerRow\.user_id !== callerId\)/);
  // the owner check comes before any report work (language lookup, output rows)
  assert.ok(s.indexOf("ownerRow.user_id !== callerId") < s.indexOf("Determine report language"));
});

test("every caller sends the Bearer token", () => {
  for (const page of ["talk/index.html", "meeting/index.html"]) {
    const p = src(page);
    let i = -1, calls = 0;
    while ((i = p.indexOf('fetch("/api/ai/generate-report"', i + 1)) !== -1) {
      calls++;
      const before = p.slice(Math.max(0, i - 900), i + 200);
      assert.match(before, /Authorization/, `${page} call #${calls} must send Authorization`);
    }
    assert.ok(calls > 0, `${page} calls generate-report`);
  }
});
