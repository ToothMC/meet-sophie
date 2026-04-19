# meet-sophie

## Local checks

No dependencies beyond Node ≥ 22. Run anytime before committing:

```bash
npm run check     # syntax + RPC drift
npm test          # smoke tests for billing-math + session-title
```

Both run automatically in CI on every push (see `.github/workflows/ci.yml`).
A red pipeline blocks merge into `main`.

### What each check catches

| Check                          | Catches                                                        | File                         |
|--------------------------------|----------------------------------------------------------------|------------------------------|
| `scripts/check-syntax.mjs`     | Unclosed brackets, missing commas, typos in any JS/MJS         | `node --check` per file      |
| `scripts/check-rpcs.mjs`       | New `supabase.rpc("…")` calls without a matching CREATE FUNCTION migration. Prevents the "production-only RPC" trap (see `supabase/MISSING_RPCS.md`) | Regex scan of `api/` + `lib/` |
| `tests/smoke/billing-constants.test.mjs` | Token-math regressions (e.g. 50-free-token legacy, wrong topup scale, plan-price drift) | `node --test` |
| `tests/smoke/session-title.test.mjs` | Keyword-classification regressions (hardcoded topic enums), whitespace handling, length caps | `node --test` |

### RPC allowlist

`supabase/rpc-allowlist.txt` tracks production-only RPCs that have no
migration yet. Every entry must be documented in `supabase/MISSING_RPCS.md`
with a recovery procedure. CI warns but doesn't fail on allowlisted names;
**new** undeclared RPCs block the build immediately.

## Directory map

- `api/` — Vercel serverless endpoints
- `lib/` — server-side helpers imported by the endpoints
- `app/`, `talk/`, `meeting/`, `pricing/`, … — static frontend routes
- `supabase/migrations/` — database schema history
- `scripts/` — build and check tooling
- `tests/smoke/` — fast pure-function tests (run on every push)
- `tests/` (root) — longer-running LLM quality evals (not in CI)
