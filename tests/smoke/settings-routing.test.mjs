// Regression 16.10.2026: the history page sent action "delete-report" only in the request
// body, but api/settings.js routes by ?action= in the URL → 400 "Missing sourceId", so no
// history entry could be deleted. Every client call must put the action in the URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
function htmlFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", ".claude", "api", "lib", "tests", "supabase", "scripts", "docs", "src"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) htmlFiles(p, out);
    else if (name.endsWith(".html")) out.push(p);
  }
  return out;
}

test("settings API routes by ?action= in the URL", () => {
  const api = readFileSync(join(ROOT, "api/settings.js"), "utf8");
  assert.match(api, /const action = req\.query\?\.action/);
});

test("every client call to /api/settings carries ?action= in the URL", () => {
  const offenders = [];
  for (const f of htmlFiles(ROOT)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/["'`]\/api\/settings(["'`?])/g)) {
      if (m[1] !== "?") offenders.push(f.replace(ROOT, ""));
    }
  }
  assert.deepEqual(offenders, []);
});

test("deleting a report checks ownership and never deletes half-way", () => {
  const api = readFileSync(join(ROOT, "api/settings.js"), "utf8");
  const block = api.slice(api.indexOf("if (action === 'delete-report')"), api.indexOf("const { sourceId } = body;"));
  // No separate report delete — user_sessions cascades to conversation_outputs
  assert.doesNotMatch(block, /from\('conversation_outputs'\)\.delete\(\)/);
  // Talk path: ownership check before the delete
  const elseAt = block.indexOf("} else {");
  const own = block.indexOf(".from('user_sessions').select('id').eq('id', session_id).eq('user_id', user.id)", elseAt);
  const del = block.indexOf(".from('user_sessions').delete()", elseAt);
  assert.ok(own > elseAt && own < del, "ownership check must come before the delete");
  // Meeting path: meeting row before its session (FK without cascade, incident 16.10.2026)
  const mDel = block.indexOf(".from('meetings').delete()");
  const sDel = block.indexOf(".from('user_sessions').delete()");
  assert.ok(mDel > 0 && mDel < sDel, "meeting must be deleted before its session");
});

test("meeting API deletes the meeting before its report session", () => {
  const api = readFileSync(join(ROOT, "api/meeting.js"), "utf8");
  const fn = api.slice(api.indexOf("async function handleDelete("));
  const mDel = fn.indexOf('.from("meetings")\n    .delete()');
  const sDel = fn.indexOf('.from("user_sessions").delete()');
  assert.ok(mDel > 0 && sDel > mDel, "meeting first, then session");
  assert.doesNotMatch(fn.slice(0, fn.indexOf("return res.status(200)")), /from\("conversation_outputs"\)\.delete\(\)/);
});
