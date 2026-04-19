#!/usr/bin/env node
// scripts/check-syntax.mjs
//
// Runs `node --check` against every JS/MJS file under api/, lib/, scripts/, tests/.
// Catches syntax errors (unclosed brackets, typos, missing commas) before CI runs
// anything expensive. Fast enough to run on every commit.
//
// Exits non-zero on the first failing file; prints the path so you know where to look.

import { readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const ROOTS = ["api", "lib", "scripts", "tests"];
const EXT = new Set([".js", ".mjs"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "dist"]);

async function walk(dir, acc = []) {
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
    if (entry.isDirectory()) {
      await walk(p, acc);
    } else if (EXT.has(path.extname(entry.name))) {
      acc.push(p);
    }
  }
  return acc;
}

function checkOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--check", file], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ file, code, stderr }));
  });
}

const files = (await Promise.all(ROOTS.map((r) => walk(r)))).flat();
console.log(`[check-syntax] checking ${files.length} files`);

let failed = 0;
for (const f of files) {
  const r = await checkOne(f);
  if (r.code !== 0) {
    console.error(`\n❌ ${r.file}`);
    console.error(r.stderr.trim());
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\n[check-syntax] ${failed} file(s) with syntax errors`);
  process.exit(1);
}
console.log("[check-syntax] all clean");
