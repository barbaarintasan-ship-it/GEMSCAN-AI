# Production Deployment Runbook — Enterprise Foundation

**Target:** Supabase project `znqkzgswvhbkhxldbbld` (linked). Deploys migrations
`0018–0058` (enterprise/geo/ml), exposes the `enterprise` + `geo` schemas, and deploys
the `enterprise-context` + `geocontext` Edge Functions.

> **Who runs this:** YOU (you hold the credentials). The assistant cannot authenticate
> here (`SUPABASE_ACCESS_TOKEN` absent → API Unauthorized; `SUPABASE_DB_PASSWORD` unset)
> and does not handle tokens/passwords. If you set those as env vars in your own shell,
> the assistant can then run the non-interactive steps — your choice.

> **Public/consumer safety:** migrations 0018–0058 only CREATE the `enterprise`/`geo`/`ml`
> schemas + extensions; they do **not** modify the `public` schema (22 consumer tables).
> Still, treat this as a live-DB change and follow the pre-flight gates.

---

## PRE-FLIGHT (all must pass before any push)

### P0 — Backup / restore point
- Confirm a recent **PITR / DB backup** exists for the project (Supabase Dashboard →
  Database → Backups). **Do not proceed without a restore point.**

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
    (or commit the real files) so histories match; **never** let `db push` try to
    re-create existing objects.
- Confirm `0018–0058` are **Local-only** (not yet on Remote) — those are what will apply.

### P3 — Clean config.toml (de-entangle)
- `supabase/config.toml` currently mixes the deploy-relevant edits
  (`[api].schemas = [..., "enterprise", "geo"]`, `[functions.enterprise-context]`,
  `[functions.geocontext]`) with **unrelated uncommitted payment-webhook edits**.
- Review `git diff supabase/config.toml`, stage/commit the intended lines deliberately.

---

## STEP 1 — Database push
```bash
supabase db push               # applies 0018–0058 (prompts for DB password)
```
Verify:
```bash
supabase migration list        # 0058 now shows applied on Remote
```
- Spot-check (SQL editor / Management API): schemas `enterprise`,`geo`,`ml` exist;
  `public` still 22 tables; `select count(*) from pg_policies where schemaname in
  ('enterprise','geo','ml')` = 84.

## STEP 2 — Expose schemas to PostgREST
- Dashboard → **Project Settings → API → Exposed schemas** → add **`enterprise`, `geo`**
  (keep `public`, `graphql_public`). *(Or Management API `PATCH /v1/projects/{ref}/postgrest`
  with the updated `db_schema`.)*
- This matches `config.toml [api].schemas`. `ml` stays unexposed (service-only).
- Verify: authenticated REST call to a `geo` reference table returns rows (RLS-scoped).

## STEP 3 — Deploy Edge Functions
```bash
supabase functions deploy enterprise-context
supabase functions deploy geocontext
```
- Secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are provided
  by the platform automatically — no new secrets needed for these two functions.
- `verify_jwt=true` for both (from config.toml).
- Verify: call `enterprise-context` with the owner JWT → `enterpriseEnabled:true`; call
  `geocontext` with `{lat,lng}` → GeoContext JSON (providers return empty until data is
  loaded — expected pre-data).

---

## POST-DEPLOY
- Smoke test both functions with a real owner-account JWT.
- Confirm consumer app unaffected (public schema untouched; existing functions unchanged).
- Note: **providers return empty** until reference/ontology/GIS/occurrence data is loaded
  (that is the next work item — data loading + Knowledge Extraction Pipeline).

## ROLLBACK / ABORT
- If `db push` fails mid-way: it is transactional per migration; fix the failing migration,
  re-run. If a bad state results, restore from the P0 backup/PITR.
- Exposed-schemas + function deploys are reversible (remove schema from the list;
  redeploy/prior version).

---
**Assistant status:** cannot execute from this environment (no access token / DB
password; will not handle secrets). Provide auth (run P1 yourself, or set
`SUPABASE_ACCESS_TOKEN` + `SUPABASE_DB_PASSWORD` in your shell) and the assistant can run
the non-interactive Steps 1–3, or you run the runbook directly.
