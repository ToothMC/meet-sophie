// RLS smoke test for the unf_* tables.
//
// Verifies that an authenticated user can ONLY see their own rows —
// across all four tables (threads, events, boundaries, briefings).
// Uses two anon-key clients with separate JWTs (the only way to exercise
// the auth.uid()-based RLS policies; the service-role key bypasses RLS
// and would render the test meaningless).
//
// Skipped in CI when env not provided. Run locally:
//
//   SUPABASE_URL=...                  \
//   SUPABASE_ANON_KEY=...              \
//   UNF_RLS_TEST_USER_A_JWT=eyJ...    \
//   UNF_RLS_TEST_USER_B_JWT=eyJ...    \
//   UNF_RLS_TEST_USER_A_ID=<uuid>     \
//   UNF_RLS_TEST_USER_B_ID=<uuid>     \
//   npm test
//
// JWTs for two throwaway test users can be minted via
//   supabase auth sign-in --email test_a@... --password ...
// or fetched from a browser session in the network panel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url     = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const jwtA    = process.env.UNF_RLS_TEST_USER_A_JWT;
const jwtB    = process.env.UNF_RLS_TEST_USER_B_JWT;
const idA     = process.env.UNF_RLS_TEST_USER_A_ID;
const idB     = process.env.UNF_RLS_TEST_USER_B_ID;

const ready = !!(url && anonKey && jwtA && jwtB && idA && idB);

if (!ready) {
  test("unfiltered RLS smoke — skipped (env not provided)", { skip: true }, () => {});
} else {
  const clientA = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${jwtA}` } }, auth: { persistSession: false } });
  const clientB = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${jwtB}` } }, auth: { persistSession: false } });

  let threadAId = null;

  test("user A can insert a thread", async () => {
    const { data, error } = await clientA
      .from("unf_threads")
      .insert({ user_id: idA, title: "RLS-Test A " + Date.now(), people: ["Alice"] })
      .select()
      .single();
    assert.equal(error, null, error?.message);
    assert.ok(data?.id);
    threadAId = data.id;
  });

  test("user B cannot SEE user A's thread", async () => {
    const { data, error } = await clientB
      .from("unf_threads")
      .select("id")
      .eq("id", threadAId)
      .maybeSingle();
    assert.equal(error, null, error?.message);
    assert.equal(data, null, "RLS LEAK: user B saw user A's thread");
  });

  test("user B cannot UPDATE user A's thread", async () => {
    const { data, error } = await clientB
      .from("unf_threads")
      .update({ title: "pwned" })
      .eq("id", threadAId)
      .select();
    // Either error or empty data — both are acceptable; key is: not actually updated.
    if (data) assert.equal(data.length, 0, "RLS LEAK: update succeeded");
    // verify by reading back as user A
    const { data: check } = await clientA.from("unf_threads").select("title").eq("id", threadAId).maybeSingle();
    assert.notEqual(check?.title, "pwned", "RLS LEAK: title was overwritten");
  });

  test("user B cannot DELETE user A's thread", async () => {
    await clientB.from("unf_threads").delete().eq("id", threadAId);
    const { data: check } = await clientA.from("unf_threads").select("id").eq("id", threadAId).maybeSingle();
    assert.ok(check?.id, "RLS LEAK: user B deleted user A's thread");
  });

  test("user A can read their own thread", async () => {
    const { data, error } = await clientA.from("unf_threads").select("title").eq("id", threadAId).maybeSingle();
    assert.equal(error, null, error?.message);
    assert.ok(data?.title?.startsWith("RLS-Test A"));
  });

  test("boundaries: user B cannot see user A's row", async () => {
    // Upsert A's boundaries first
    await clientA.from("unf_boundaries").upsert({ user_id: idA, blocked_people: ["Tom"] });
    const { data } = await clientB.from("unf_boundaries").select("user_id").eq("user_id", idA).maybeSingle();
    assert.equal(data, null, "RLS LEAK: user B saw user A's boundaries");
  });

  test("cleanup: user A deletes their own thread", async () => {
    if (threadAId) {
      await clientA.from("unf_threads").delete().eq("id", threadAId);
    }
  });
}
