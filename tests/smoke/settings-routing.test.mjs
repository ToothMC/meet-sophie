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

test("deleting a report checks ownership before touching conversation_outputs", () => {
  const api = readFileSync(join(ROOT, "api/settings.js"), "utf8");
  const block = api.slice(api.indexOf("if (action === 'delete-report')"));
  const own = block.indexOf(".from('user_sessions').select('id').eq('id', session_id).eq('user_id', user.id)");
  const del = block.indexOf("} else {");
  const coDel = block.indexOf(".from('conversation_outputs').delete()", del);
  assert.ok(own > del && own < coDel, "ownership check must come before deleting outputs");
});
