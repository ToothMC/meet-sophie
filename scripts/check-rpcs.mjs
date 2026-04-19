#!/usr/bin/env node
// scripts/check-rpcs.mjs
//
// Guards against the "production-only RPC" trap that bit us with
// deduct_tokens / meeting_create_with_token_gate / acquire_realtime_lock /
// reserve_free_seconds (see supabase/MISSING_RPCS.md).
//
// Scans api/ and lib/ for every supabase.rpc("name") call, then verifies that
// "name" appears in at least one CREATE [OR REPLACE] FUNCTION statement under
// supabase/migrations/. If a call site has no matching definition, CI fails.
//
// Intentionally naive regex — no SQL parser. False negatives are possible if
// someone defines an RPC via dynamic SQL or outside public schema. False
// positives are acceptable (add the migration, done).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const CODE_ROOTS = ["api", "lib"];
const MIGRATIONS_DIR = "supabase/migrations";
const ALLOWLIST_PATH = "supabase/rpc-allowlist.txt";
const SKIP_DIRS = new Set(["node_modules", ".next", "dist"]);
const CODE_EXT = new Set([".js", ".mjs"]);

async function walk(dir, ext, acc = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return acc;
    throw e;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, ext, acc);
    else if (ext.has(path.extname(entry.name))) acc.push(p);
  }
  return acc;
}

// Collect all rpc("name") call sites. Returns Map<name, Array<filepath>>.
async function collectRpcCalls() {
  const out = new Map();
  const files = (await Promise.all(CODE_ROOTS.map((r) => walk(r, CODE_EXT)))).flat();
  const rx = /\.rpc\(\s*['"`]([a-zA-Z0-9_]+)['"`]/g;
  for (const f of files) {
    const src = await readFile(f, "utf8");
    let m;
    while ((m = rx.exec(src)) !== null) {
      const name = m[1];
      if (!out.has(name)) out.set(name, []);
      out.get(name).push(f);
    }
  }
  return out;
}

// Collect all defined RPC names from migrations. Returns Set<name>.
async function collectDefinedRpcs() {
  const out = new Set();
  const files = (await walk(MIGRATIONS_DIR, new Set([".sql"])));
  // Matches: CREATE FUNCTION public.name(...) | CREATE OR REPLACE FUNCTION name(...)
  const rx = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-zA-Z0-9_]+)\s*\(/gi;
  for (const f of files) {
    const src = await readFile(f, "utf8");
    let m;
    while ((m = rx.exec(src)) !== null) {
      out.add(m[1]);
    }
  }
  return out;
}

// Allowlist: known-missing RPCs that live in production only. Every entry here
// must be documented in supabase/MISSING_RPCS.md with recovery instructions.
// This is a transitional safety valve, NOT an open door — CI still warns on
// every allowlisted hit so the list stays visible.
async function loadAllowlist() {
  try {
    const raw = await readFile(ALLOWLIST_PATH, "utf8");
    return new Set(
      raw.split("\n")
        .map((l) => l.replace(/#.*$/, "").trim())
        .filter(Boolean)
    );
  } catch (e) {
    if (e.code === "ENOENT") return new Set();
    throw e;
  }
}

const called = await collectRpcCalls();
const defined = await collectDefinedRpcs();
const allowed = await loadAllowlist();

const hardMissing = [];
const softMissing = [];
for (const [name, sites] of called) {
  if (defined.has(name)) continue;
  if (allowed.has(name)) softMissing.push({ name, sites });
  else hardMissing.push({ name, sites });
}

console.log(`[check-rpcs] ${called.size} distinct RPC(s) called, ${defined.size} defined, ${allowed.size} allowlisted`);

if (softMissing.length > 0) {
  console.warn("\n⚠️  RPCs on allowlist (production-only, documented in supabase/MISSING_RPCS.md):");
  for (const { name } of softMissing) console.warn(`   ${name}`);
}

if (hardMissing.length > 0) {
  console.error("\n❌ RPCs called by code but NOT defined AND NOT allowlisted:");
  for (const { name, sites } of hardMissing) {
    console.error(`\n  ${name}`);
    for (const s of sites) console.error(`    called from: ${s}`);
  }
  console.error(
    "\nFix: either add a CREATE FUNCTION migration, or add the name to\n" +
    `  ${ALLOWLIST_PATH}\n` +
    "and document it in supabase/MISSING_RPCS.md.\n" +
    "See supabase/MISSING_RPCS.md for the export procedure."
  );
  process.exit(1);
}

console.log("[check-rpcs] all called RPCs are covered (migration or allowlist)");
