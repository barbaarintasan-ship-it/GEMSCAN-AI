# Production Deployment Runbook — Enterprise Foundation + Sprint 4.2

**Target:** Supabase project `znqkzgswvhbkhxldbbld` (linked). Deploys migrations
`0018–0059` (enterprise / geo / ml + the Sprint 4.2 `submit_sample` RPC), exposes the
`enterprise` + `geo` schemas, and deploys the `enterprise-context`, `geocontext`, and
`enterprise-samples` Edge Functions.

> **Who runs this:** YOU (you hold the credentials). The assistant cannot authenticate
> here (`SUPABASE_ACCESS_TOKEN` absent → API Unauthorized; `SUPABASE_DB_PASSWORD` unset)
> and does not handle tokens/passwords. Run the commands in your own terminal and paste
> the output back — the assistant will read it and tell you the next move.

> **Public/consumer safety:** migrations 0018–0059 only CREATE/extend the
> `enterprise` / `geo` / `ml` schemas + extensions; they do **not** modify the `public`
> schema (22 consumer tables). Still, treat this as a live-DB change and follow the
> pre-flight gates.

> **What changed vs. the previous runbook (Sprint 4.2):** migration **`0059`**
> (`enterprise.submit_sample`), function **`enterprise-samples`**, and the
> `config.toml` block **`[functions.enterprise-samples] verify_jwt=true`** are now
> included. `0059` must be pushed BEFORE `enterprise-samples` is deployed (the function
> calls that RPC).

---

## PRE-FLIGHT (all must pass before any push)

### P0 — Backup / restore point
- Confirm a recent **PITR / DB backup** exists (Supabase Dashboard → Database → Backups).
  **Do not proceed without a restore point.**

### P1 — Authenticate
```bash
supabase login                 # interactive (browser/token) — sets access token
supabase link --project-ref znqkzgswvhbkhxldbbld
```

### P2 — ⚠️ Migration-history reconciliation (CRITICAL)
```bash
supabase migration list        # shows Local vs Remote applied
```
- Confirm **Remote** has the consumer migrations (`0001…`).
- **Check the 0013–0015 gap:** locally `0013_gold_verification`, `0014_security_fixes`,
  `0015_artifact_verification` are **uncommitted/untracked**. If **Remote already has**
  gold/artifact verification (the live consumer app uses it) but Local does not, you have
  **drift**. Resolve BEFORE pushing:
  - If prod has 0013–0015: `supabase migration repair --status applied 0013 0014 0015`
    (or commit the real files) so histories match; **never** let `db push` re-create
    existing objects.
- Confirm `0018–0059` are **Local-only** (not yet on Remote) — those are what will apply.

### P3 — Clean config.toml (de-entangle)
- `supabase/config.toml` currently mixes the deploy-relevant edits
  (`[api].schemas = [..., "enterprise", "geo"]`, and the `[functions.enterprise-context]`,
  `[functions.geocontext]`, `[functions.enterprise-samples]` blocks — all `verify_jwt=true`)
  with **unrelated uncommitted payment-webhook edits**.
- `supabase functions deploy` reads `verify_jwt` from this file, so the enterprise blocks
  must be present at deploy time (they are). Review `git diff supabase/config.toml` and
  commit the intended lines deliberately; leave the payment edits for their own change.

---

## STEP 1 — Database push
```bash
supabase db push               # applies 0018–0059 (prompts for DB password)
```
Verify:
```bash
supabase migration list        # 0059 now shows applied on Remote
```
- Spot-check (SQL editor): schemas `enterprise`, `geo`, `ml` exist; `public` still 22
  tables; the `enterprise.submit_sample(uuid, jsonb)` function exists and is
  execute-granted to `service_role` **only** (not `authenticated`):
```sql
select has_function_privilege('service_role','enterprise.submit_sample(uuid,jsonb)','execute') as svc,
       has_function_privilege('authenticated','enterprise.submit_sample(uuid,jsonb)','execute') as auth;
-- expect: svc = true, auth = false
```

## STEP 2 — Expose schemas to PostgREST
- Dashboard → **Project Settings → API → Exposed schemas** → add **`enterprise`, `geo`**
  (keep `public`, `graphql_public`). *(Or Management API `PATCH /v1/projects/{ref}/postgrest`
  with the updated `db_schema`.)*
- Matches `config.toml [api].schemas`. `ml` stays unexposed (service-only).
- The `enterprise-samples` reads (`GET` list / detail) go through PostgREST on the
  `enterprise` schema — this step is what makes those reads work in production.

## STEP 3 — Deploy Edge Functions
```bash
supabase functions deploy enterprise-context
supabase functions deploy geocontext
supabase functions deploy enterprise-samples
```
- Secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are provided
  by the platform automatically — no new secrets needed.
- `verify_jwt=true` for all three (from config.toml).
- Verify:
  - `enterprise-context` with the owner JWT → `enterpriseEnabled:true`.
  - `geocontext` with `{lat,lng}` → GeoContext JSON (providers empty until data loaded).
  - `enterprise-samples` `GET` with the owner JWT → `{ "samples": [] }` (empty pre-data,
    200 — proves auth + enterprise gate + RLS read path).

---

## POST-DEPLOY — Sprint 4.2 owner smoke test (mobile)
Log into the mobile app as the owner (`awmusse.musse@gmail.com`) and:
1. Home shows **“Enterprise · Field Samples”** (owner-only entry).
2. **New Sample** → GPS fix appears → add a photo → add a mineral → **Submit** → lands on
   the detail screen.
3. **My Samples** lists it; opening it shows GPS + photo + mineral.

⚠️ **Storage-path check (only real unknown):** photos upload to the existing
`scan-images` bucket under `enterprise/{userId}/…`. Confirm that bucket's Storage RLS
allows the owner to upload at that prefix. If the upload returns a policy error, either
add a Storage policy for the `enterprise/` prefix **or** change the path in
`mobile/lib/enterpriseSamples.ts` (`uploadSampleMedia`) to match the existing allowed
prefix. Submitting **without** a photo is unaffected and a good first test.

- Confirm consumer app unaffected (public schema untouched; existing functions unchanged).
- Note: geo/geocontext **providers return empty** until reference/ontology/GIS/occurrence
  data is loaded (next work item — data loading + Knowledge Extraction Pipeline).

## ROLLBACK / ABORT
- `db push` is transactional per migration; if one fails, fix it and re-run. If a bad
  state results, restore from the P0 backup/PITR.
- Exposed-schemas + function deploys are reversible (remove schema from the list;
  redeploy a prior function version).

---
**Assistant status:** cannot execute from this environment (no access token / DB password;
will not handle secrets). Run the steps in your terminal and paste the output of each
`supabase …` command back here — the assistant will interpret it and guide the next step.
