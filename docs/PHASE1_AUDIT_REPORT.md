# Luul Scan Enterprise — Phase 1 STEP 0: Repository Audit Report

| | |
|---|---|
| **Step** | STEP 0 — Repository audit (read-only) |
| **Status** | Complete — **nothing was modified** |
| **Purpose** | Establish the exact current state before any enterprise implementation |
| **Governing docs** | Architecture v1.0 · Addendum A1 · Phase 1 Engineering Spec v1.0 |

> This report is the pre-implementation baseline. **No schemas, tables, policies, config, or app files were changed.** It records what exists, what must stay untouched, where the enterprise module integrates, and the risks to resolve before STEP 1.

---

## 1. Method

Read-only inspection of: `supabase/migrations/*` (0001–0017), `supabase/functions/*`, `supabase/config.toml`, and `mobile/` (Expo/RN app, Supabase client, auth). No database connection was made; findings are from the migration source of truth (the repo's declared schema) and app source.

---

## 2. Current database state

### 2.1 Schemas
- **Single application schema: `public`.** All ~24 application tables live here.
- **API-exposed schemas** (`config.toml [api].schemas`): `["public", "graphql_public"]`.
- **No `enterprise`, `geo`, or `ml` schema exists** → the three new schemas are **greenfield, zero collision**.

### 2.2 Extensions (currently enabled by migrations)
- `pg_trgm` (migration 0002) — trigram search for hallmark matching.
- **PostGIS: NOT enabled.** **pgcrypto: not explicitly enabled by a migration** (Supabase typically provides `gen_random_uuid()` via the `extensions` schema by default, but STEP 1 must enable/verify `pgcrypto` explicitly).
- **H3 (`h3`/`h3-pg`): not present** → confirms the spec's default of **app/Edge-computed H3 string** (no hard extension dependency).

### 2.3 Table inventory (all in `public`, all RLS-enabled)

| Group | Tables |
|---|---|
| Identity & billing | `profiles`, `subscriptions`, `payment_events`, `app_config` |
| Scan pipeline | `scans`, `scan_images`, `scan_ai_responses`, `scan_candidates`, `scan_feedback`, `reference_hallmarks` |
| Usage & credits | `scan_usage`, `deep_scan_credits`, `credit_packages` |
| Verification & paywalls | `diamond_verifications`(+`_verdicts`), `high_value_report_purchases`, `gold_verifications`(+`_verdicts`), `gold_report_purchases`, `artifact_verifications`(+`_verdicts`), `artifact_report_purchases` |

Notable: **`public.scans` already has `capture_location jsonb`, `final_result jsonb`, `created_at`** — these are the exact columns the current Gold Prospect screen reads, and the enterprise **promotion path** will read (read-only).

### 2.4 RLS pattern (established convention to mirror)
- Every table has `enable row level security` + owner-scoped policies named `<table>_select_own` / `_insert_own` / `_update_own`, keyed on `auth.uid() = user_id`.
- Public-read exceptions: `app_config`, `credit_packages`, `reference_hallmarks` (`*_public_read` / `*_select_all`).
- **Implication:** enterprise policies should follow the same naming/structure convention for consistency.

### 2.5 Storage
- **One bucket: `scan-images`** (`public = false`), created in 0002.
- `storage.objects` policies: insert/select gated on `(storage.foldername(name))[1] = auth.uid()::text` (user-namespaced path). **No client update/delete** (images immutable; cleanup is a service-role job).
- **New enterprise buckets (`sample-media`, `sample-thumbnails`, `exports`) do not exist** → no name collision.

### 2.6 Triggers & functions
- `set_updated_at()` (0002) + per-table `*_set_updated_at` triggers — **reusable pattern** for enterprise `updated_at`.
- Auth: `handle_new_user()` + `handle_new_user_subscription()` fire on `auth.users` insert → create `profiles` + `subscriptions`. Email change handled by `enforce_profile_email_immutable` / `handle_user_email_change`.
- Business RPCs: analytics, public stats, credit management, evaluation-slot reservation (race-safe) — **none touched by enterprise**.

### 2.7 Migration numbering
- Sequential: `0001`…`0017` (latest: `0017_app_config_latest_build_37.sql`).
- **Next enterprise migration = `0018_…` onward.** Must not renumber or edit existing files.

### 2.8 Auth model
- Supabase Auth (`auth.users`) is the single identity. JWT expiry 3600s; `enable_confirmations = false` (mobile signup returns a session immediately).
- `verify_jwt` is set **per function** in `config.toml` (user-called functions verify JWT; webhooks/server-to-server skip it).

---

## 3. React Native / Expo architecture

| Aspect | Current state |
|---|---|
| Expo SDK | **51** (RN **0.74.5**, Hermes) |
| Supabase client | `mobile/lib/supabase.ts` — **auth-only + `verify-subscription`**; encrypted session via `secureStorageAdapter`; anon key from `EXPO_PUBLIC_*` env |
| API schema access | supabase-js default schema is `public`. Reading `enterprise.*` via PostgREST would require **exposing the `enterprise` schema** (see §5) or going through Edge Functions |
| Auth flow | `mobile/lib/auth.tsx` `AuthProvider` — `signIn/signUp/updateProfile/resetPassword`; session in SecureStore |
| Navigation | expo-router; consumer tabs (`Scan`/`Explorer`) under `app/(app)/` |
| Offline DB | **None today** — no SQLite/WatermelonDB dependency yet (offline queue is new work in Sprint 6) |
| Native modules | camera, location, image-picker, webview, view-shot, secure-store. **No** react-native-svg / reanimated / postgis client. Committed `android/` + local build recipe (JDK 17) |
| Entitlements | `lib/subscription.ts` already carries optional `goldProspectEvaluation` flag; `lib/entitlements.ts` resolver (already committed) |

---

## 4. Integration points (where enterprise attaches)

| Integration | Direction | Notes |
|---|---|---|
| `auth.users(id)` | enterprise → auth | `field_contributor.user_id`, `*.creator_id/collector_id/owner_id` FK here |
| `public.profiles` | enterprise reads | Display name/contact for contributor UI — **read-only, no writes** |
| `public.scans.capture_location` / `final_result`, `public.scan_candidates` | promotion path reads | Consumer→enterprise promotion (arch §5.2) reads these **read-only**; never FKs into them |
| `mobile/lib/supabase.ts` client | shared | Enterprise reuses the same authenticated client (Edge Fn calls; optional `.schema('enterprise')` reads if exposed) |
| Edge Functions runtime + `supabase/functions/_shared` | shared | New enterprise functions can reuse shared helpers/patterns |
| `config.toml [functions.*]` | additive | New functions need `verify_jwt = true` entries |

---

## 5. Potential conflicts

| # | Conflict | Severity | Resolution |
|---|---|---|---|
| C1 | **API schema exposure** — supabase-js can only PostgREST-read schemas in `[api].schemas`. Enterprise reads need `enterprise` added, OR all reads via Edge Fn | Medium | **Decision required** (see §7-D1). Recommended: expose `enterprise` for RLS-protected reads; keep **all writes** in Edge Functions |
| C2 | **pgcrypto / `gen_random_uuid()`** location | Low | STEP 1 explicitly enables/verifies `pgcrypto`; qualify function or set search_path |
| C3 | **PostGIS not enabled** | Low | STEP 1 enables `postgis` (Supabase-supported); heavy but standard |
| C4 | **H3 extension absent** | Low | Use app/Edge-computed H3 text (already the spec default) |
| C5 | **Migration numbering** | Low | Start at `0018_`; never edit 0001–0017 |
| C6 | **`updated_at` trigger reuse** | Low | Define `enterprise.set_updated_at()` (don't overload the public one) |
| C7 | **Local vs hosted config drift** — `config.toml` changes only affect local `supabase start`; hosted project must be updated too (same caveat already noted for `enable_confirmations`) | Medium | Apply schema-exposure + function config to hosted project via dashboard / `config push` |
| C8 | **Adding Expo SQLite (Sprint 6)** is a native change | Medium | First-party `expo-sqlite`; preserve committed `android/` + JDK-17 build recipe; rebuild + test |

**No table-name, schema-name, or bucket-name collisions exist.**

---

## 6. Files & objects that MUST remain untouched

**Database (do not edit/alter):**
- All existing migrations `0001_…`–`0017_…`.
- Every `public.*` table, its RLS policies, and its triggers/functions.
- `storage` bucket `scan-images` and its `storage.objects` policies.
- Auth triggers `handle_new_user*`, email-immutability triggers.

**Supabase Edge Functions (do not edit):**
- `orchestrate-scan`, `precheck-object`, `estimate-value`, `verify-subscription`, `create-checkout-session`, `activate-subscription`, all `*-webhook`, `gemscan-analytics`, `gemscan-users`, `delete-account`, `delete-scan`, verification functions.

**Mobile consumer code (do not modify behavior):**
- `app/(app)/scan/*` (Gem Collector/Explorer, capture, results, valuation), `lib/scanUpload.ts`, `lib/valuation.ts`, `lib/scanReport.ts`, existing navigation (`app/_layout.tsx`, `app/(app)/_layout.tsx`), `lib/auth.tsx` behavior, `lib/subscription.ts` public contract.

**Config:**
- Existing `config.toml [functions.*]` entries and auth settings (only **add** new entries).

> Enterprise work is **additive**: new schemas, new tables, new buckets, new functions, a new isolated app module. Nothing above is rewritten.

---

## 7. Open decisions to resolve before STEP 1

| ID | Decision | Recommendation |
|---|---|---|
| **D1** | Expose `enterprise` (and later `geo`) to PostgREST API, or route all reads through Edge Functions? | **Expose `enterprise` for reads** (RLS-protected); **all writes via Edge Functions**. Keep `ml` unexposed. |
| **D2** | Reuse `public.profiles` for contributor display, or duplicate minimal fields into `field_contributor`? | Reuse `profiles` (read-only join); store only enterprise fields on `field_contributor`. |
| **D3** | How is a user elevated to `field_contributor`/roles? | Admin/service-role Edge Fn; default new users = `normal`; no self-elevation. |
| **D4** | Hosted-project application of `config.toml` + PostGIS enablement | Coordinate a dashboard/`config push` step; document in the migration PR. |
| **D5** | Rollback strategy granularity | Each enterprise migration paired with a documented down-path; Phase-1 rollback = `drop schema enterprise/geo/ml cascade` + revert `config.toml` (safe because additive & isolated). |
| **D6** | H3 working resolution | Data-science to fix one resolution + roll-up levels before coverage work (Sprint 7). |

---

## 8. Risk register (STEP 0)

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | Enabling PostGIS on the hosted project is heavyweight / needs the right plan | Blocks STEP 1 | Confirm PostGIS availability on the Supabase plan first; test on local/branch DB |
| R2 | Exposing a new schema widens attack surface | Data leak | Strict RLS on every enterprise table + Edge-Fn-only writes; anon fully denied |
| R3 | Running migrations against **production data** | Outage/regression | Additive-only (`create … if not exists`); **zero** ALTER of `public`; test on a Supabase **branch** or local shadow first |
| R4 | Config drift (local vs hosted) | Silent failures | Apply and verify config on hosted project; add a checklist to the migration PR |
| R5 | Offline module (Expo SQLite) native footprint | Breaks local build | First-party module; rebuild v-next; verify JDK-17 recipe + Android 16 target still build |
| R6 | Polymorphic `verification_record` integrity | Data quality | Enforce in Edge Fn + check constraints; revisit split tables if RLS complexity grows |
| R7 | Idempotency gaps on offline sync | Duplicate rows | Client-supplied UUIDs + upsert; dedupe guard on `(collector_id, location, collected_at)` |
| R8 | Scope creep into later-phase work (AI/maps/DEM) | Timeline/complexity | Hard Phase-1 boundary; STEP list is the contract |

---

## 9. Go / no-go recommendation

**Green to proceed to STEP 1**, conditional on resolving **D1** (API exposure), **D4/R1** (PostGIS availability + hosted config), and confirming the **branch/local test** approach (R3).

The enterprise module is **cleanly additive**: new schemas, tables, buckets, and functions with **no collisions** and **no required edits to any existing object**. The consumer app and its data remain fully isolated.

**STEP 1 will (only):** create schemas `enterprise`/`geo`/`ml`, enable `postgis` + `pgcrypto`, and create the enum types — as one additive migration (`0018_…`) with a documented rollback (`drop schema … cascade`). No tables, no app code, until STEP 1 is verified and approved.

---

*End of STEP 0 audit. Read-only — nothing was modified. Awaiting approval to begin STEP 1.*
