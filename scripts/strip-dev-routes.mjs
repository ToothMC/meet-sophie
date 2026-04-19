#!/usr/bin/env node
// scripts/strip-dev-routes.mjs
//
// Removes *-dev/ directories from the deploy tree when building for
// production. Vercel preview deploys (VERCEL_ENV=preview) and local
// dev (no VERCEL_ENV) keep the dev routes so we can iterate against
// them. Only production-grade deploys strip them.
//
// Affected paths:
//   - talk-dev/             (Dev-flavor of the talk UI)
//   - login-dev/            (Dev login screen, still wires magic links)
//   - auth/callback-dev/    (Dev OAuth callback)
//
// This is a blast-radius guard: the dev routes have been found to
// contain auth flows that don't match the production OTP-only flow
// (see audit K-2). Keeping them reachable on www.meet-sophie.com
// risks users stumbling into a broken path or regressing the magic-
// link dual-tab bug noted in the team's memory.

import { rm, stat } from 'node:fs/promises';

const env = process.env.VERCEL_ENV || '';

if (env !== 'production') {
  console.log(`[strip-dev-routes] skipping (VERCEL_ENV="${env}", only active in production)`);
  process.exit(0);
}

const DEV_PATHS = [
  'talk-dev',
  'login-dev',
  'auth/callback-dev',
];

let removed = 0;
for (const p of DEV_PATHS) {
  try {
    await stat(p);
  } catch {
    continue; // path does not exist, nothing to strip
  }
  await rm(p, { recursive: true, force: true });
  console.log(`[strip-dev-routes] removed ${p}/`);
  removed += 1;
}

if (removed === 0) {
  console.log('[strip-dev-routes] no dev paths present — nothing to strip');
} else {
  console.log(`[strip-dev-routes] stripped ${removed} dev route(s) from production bundle`);
}
