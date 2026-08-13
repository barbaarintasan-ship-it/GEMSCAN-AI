# Owner Beta — Sample Submission End-to-End Test Plan (Sprint 4.2)

Everything required to manually validate the complete Sample Submission workflow —
login → New Sample → submit → view — against **production** (`znqkzgswvhbkhxldbbld`).
No new features; this only prepares and verifies the existing pipeline.

---

## 0. Current deployed state (already done)

| Item | State |
|---|---|
| Migrations `0018–0059` (incl. `enterprise.submit_sample`) | ✅ applied to prod |
| `enterprise` + `geo` schemas exposed (Data API → Settings) | ✅ |
| `authenticated` USAGE on `enterprise` + SELECT on sample tables (0037) | ✅ |
| `service_role` execute on `submit_sample` (0059) | ✅ |
| Functions `enterprise-context`, `geocontext`, `enterprise-samples` | ✅ ACTIVE, `verify_jwt=true` |
| Mobile screens + client (owner-gated) | ✅ committed |
| Media path fixed to `{uid}/enterprise/…` for scan-images RLS | ✅ committed (`28c068d`) |

---

## 1. Seed data required — **NONE**

- **Enterprise access:** `requireEnterprise` → `isEnterpriseEnabled` returns `true` for the
  owner **by email** (`isOwnerEmail`). No `field_contributor`, org, or entitlement row is needed.
- **Exploration area:** `submit_sample` **auto-creates** "Owner Beta Field Collection"
  (`project_id = null`, `created_by = owner`) on the first submit, and reuses it after.
- **The one prerequisite:** an auth account whose email is **exactly `awmusse.musse@gmail.com`**
  must exist. If it doesn't, sign up in the app with that email once (email confirmation is off).

> ⚠️ You must log in as **`awmusse.musse@gmail.com`** — the owner. Any other account
> (e.g. `barbaarintasan@gmail.com`) will **not** see the enterprise entry (403 by design).

Verify the owner account exists (Dashboard → SQL Editor):
```sql
select id, email, created_at from auth.users where email = 'awmusse.musse@gmail.com';
-- expect: exactly 1 row. Note the id (call it OWNER_UID) for the checks below.
```

---

## 2. Environment variables

**Backend (Edge Functions):** none to set — `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` are injected by the platform. No new secrets.

**Mobile:** already configured, pointing at prod:
- `mobile/.env` (local dev) and `mobile/eas.json` (build profiles) both set:
  - `EXPO_PUBLIC_SUPABASE_URL = https://znqkzgswvhbkhxldbbld.supabase.co`
  - `EXPO_PUBLIC_SUPABASE_ANON_KEY = sb_publishable_…`
  - `EXPO_PUBLIC_SUPABASE_FUNCTIONS_URL = https://znqkzgswvhbkhxldbbld.functions.supabase.co`

Nothing to change.

---

## 3. Supabase configuration changes — all done

- **Exposed schemas:** `enterprise`, `geo` added (Data API → Settings). ✅
- **`config.toml`:** `[functions.enterprise-samples] verify_jwt = true` is present locally.
  It is read at deploy time (already deployed correctly). The file also carries unrelated
  uncommitted payment-webhook edits — leave those for a separate change; they do not affect
  this test.

---

## 4. Commands to run locally

Pick ONE path.

### Path A — Play Console internal build (production-like, recommended)
```bash
cd "C:\Users\awmus\OneDrive\Documents\GEMSCAN AI\mobile"
npx eas build -p android --profile production
```
- Produces a signed `.aab`, auto-increments versionCode, gives a download URL.
- Play Console → **Testing → Internal testing → Create new release** → upload `.aab` →
  add tester `awmusse.musse@gmail.com` → Rollout → install from the tester link.

### Path B — Local dev client (fast iteration)
```bash
cd "C:\Users\awmus\OneDrive\Documents\GEMSCAN AI\mobile"
npx eas build -p android --profile development   # one-time: dev-client APK
# install that APK on the device, then:
npx expo start --dev-client
```
- Scan the QR / connect; the app loads from Metro against prod backend.
- (Camera + GPS need a real device + dev build — Expo Go won't work with the native modules.)

---

## 5. Deploy ONLY the enterprise-samples function (if you change it)

Already deployed. Re-deploy only after editing its handler:
```bash
cd "C:\Users\awmus\OneDrive\Documents\GEMSCAN AI"
npx supabase functions deploy enterprise-samples --use-api
```
(`--use-api` bundles server-side; no Docker needed.)

---

## 6. Step-by-step test — login to viewing a sample

Each step lists its **✅ expected result**.

| # | Action | ✅ Expected |
|---|---|---|
| 1 | Open app, log in as `awmusse.musse@gmail.com` | Home screen loads |
| 2 | Look on the Home screen | A **"Enterprise · Field Samples"** row is visible (owner-only) |
| 3 | Tap it | **My Samples** opens; first run shows the empty state "No samples yet" |
| 4 | Tap **New Sample** | Form opens; **"Getting GPS fix…"** then coordinates appear (allow location permission) |
| 5 | Tap **Add** (photo), take a picture | A thumbnail appears (first = `context`, next = `surface_closeup`) |
| 6 | Type a mineral (e.g. `quartz`), tap **Add** | A `quartz` chip appears |
| 7 | (Optional) host rock `granite`, field notes | Text stored in the fields |
| 8 | Tap **Submit Sample** | Button shows "Submitting…"; on success you land on the **Sample Details** screen |
| 9 | Read the detail | Status badge, GPS (h3 + accuracy), your photo(s), the `quartz` chip, rock/notes all shown |
| 10 | Go back to **My Samples** (pull to refresh) | The new sample row is listed, newest first |
| 11 | (RLS) Log out; log in as a **different** account | The "Enterprise · Field Samples" row is **absent** (403 gate) |

If step 5 (photo) fails with a storage error, submit **without** a photo (steps 4,6,8) —
that still fully exercises POST → RPC → RLS. Report the error and we adjust the policy/path.

---

## 7. How to verify each guarantee (Dashboard → SQL Editor)

Run these after a submit. Replace `OWNER_UID` with the id from §1.
PostGIS lives in the `extensions` schema, so functions are schema-qualified.

**7a. Sample was created** (and area auto-made):
```sql
select s.id, s.collector_id, s.created_by, s.collected_at, s.status, a.name as area
from enterprise.sample s join enterprise.exploration_area a on a.id = s.area_id
where s.collector_id = 'OWNER_UID'
order by s.created_at desc limit 5;
-- expect: your sample; area = 'Owner Beta Field Collection'; collector_id = created_by = OWNER_UID
```

**7b. GPS was stored** (geography + h3):
```sql
select l.h3_cell, l.gps_accuracy_m, l.provenance,
       extensions.st_y(l.location::geometry) as lat,
       extensions.st_x(l.location::geometry) as lng
from enterprise.sample_location l
where l.sample_id = (select id from enterprise.sample where collector_id='OWNER_UID' order by created_at desc limit 1);
-- expect: lat/lng match where you stood; h3_cell non-null; provenance = 'gps'
```

**7c. Media uploaded + linked:**
```sql
select role, storage_path from enterprise.sample_media
where sample_id = (select id from enterprise.sample where collector_id='OWNER_UID' order by created_at desc limit 1);
-- expect: one row per photo; storage_path starts with 'OWNER_UID/enterprise/…'
```
Then confirm the object exists in the bucket (Dashboard → Storage → `scan-images` →
folder `OWNER_UID/enterprise/`), or:
```sql
select name from storage.objects
where bucket_id='scan-images' and name like 'OWNER_UID/enterprise/%'
order by created_at desc limit 5;
```

**7d. Observations were saved:**
```sql
with s as (select id from enterprise.sample where collector_id='OWNER_UID' order by created_at desc limit 1)
select
  (select count(*) from enterprise.mineral_observation   where sample_id=(select id from s)) as minerals,
  (select count(*) from enterprise.rock_observation       where sample_id=(select id from s)) as rock,
  (select count(*) from enterprise.alteration_observation where sample_id=(select id from s)) as alteration,
  (select count(*) from enterprise.structural_measurement where sample_id=(select id from s)) as structural;
-- expect: counts matching what you entered (e.g. minerals >= 1, rock = 1 if you filled it)
```

**7e. Audit log was written** (append-only, real actor):
```sql
select actor_id, action, entity_type, entity_id, after, context
from enterprise.audit_log
where entity_type='sample' and actor_id='OWNER_UID'
order by created_at desc limit 3;
-- expect: action='insert', entity_id = your sample id, actor_id = OWNER_UID,
--         context = {"source":"enterprise-samples","beta":true}
```

**7f. RLS is working** — two ways:
- **Functional (in-app):** the **My Samples** list shows ONLY your samples, and a
  non-owner account cannot even reach the screen (403). This is RLS + the enterprise gate.
- **REST proof (optional, terminal):** anon cannot read the enterprise schema —
```bash
curl -s -w "\n%{http_code}\n" \
  "https://znqkzgswvhbkhxldbbld.supabase.co/rest/v1/sample?select=id&limit=1" \
  -H "apikey: sb_publishable_tw-dAV4QosRuHR9WLWMelg_B-ZWw7ah" \
  -H "Accept-Profile: enterprise"
# expect: 401 "permission denied for schema enterprise" (anon is blocked)
```
  To prove the owner sees their own rows via REST, get an owner token by signing in
  (fill your own password — do this yourself), then query with it:
```bash
# 1) sign in (you enter your password), capture access_token from the response
curl -s "https://znqkzgswvhbkhxldbbld.supabase.co/auth/v1/token?grant_type=password" \
  -H "apikey: sb_publishable_tw-dAV4QosRuHR9WLWMelg_B-ZWw7ah" -H "content-type: application/json" \
  -d '{"email":"awmusse.musse@gmail.com","password":"YOUR_PASSWORD"}'
# 2) then, with TOKEN from above:
curl -s "https://znqkzgswvhbkhxldbbld.supabase.co/rest/v1/sample?select=id,collected_at" \
  -H "apikey: sb_publishable_tw-dAV4QosRuHR9WLWMelg_B-ZWw7ah" \
  -H "Authorization: Bearer TOKEN" -H "Accept-Profile: enterprise"
# expect: only YOUR samples returned (RLS: collector_id = auth.uid())
```

---

## 8. Master checklist (tick as you go)

- [ ] Owner account `awmusse.musse@gmail.com` exists (§1 query = 1 row)
- [ ] App installed (Path A or B) and logged in as owner
- [ ] "Enterprise · Field Samples" row visible on Home
- [ ] New Sample: GPS fix acquired
- [ ] Photo added (thumbnail shows) — or intentionally skipped
- [ ] Mineral chip added
- [ ] Submit → lands on Sample Details with all data
- [ ] My Samples lists the new sample
- [ ] 7a sample row correct (area auto-created, collector = owner)
- [ ] 7b GPS lat/lng + h3 correct
- [ ] 7c media rows + storage objects under `OWNER_UID/enterprise/`
- [ ] 7d observation counts match input
- [ ] 7e audit row: insert, owner actor, beta context
- [ ] 7f RLS: non-owner blocked in-app; anon REST = 401
- [ ] Consumer app unaffected (normal scan still works)

---

## 9. Known limitations of the current Owner Beta

1. **Single owner only.** Access is `isOwnerEmail` (`awmusse.musse@gmail.com`) or an
   active-org entitlement (not built yet). No other users, no org/team.
2. **No verification / provisioning / community / AI reasoning.** Sprint 4.2 is submit +
   read only. Samples stay `status` as created; no verifier flow, no GeoContext enrichment
   surfaced in the app.
3. **GeoContext providers return empty.** Reference/ontology/GIS/occurrence data is not
   loaded yet, so `geocontext` responds with empty evidence (expected pre-data).
4. **Photos share the consumer `scan-images` bucket** under `{uid}/enterprise/…`. No
   dedicated enterprise bucket, no thumbnail generation (thumb_path is null unless supplied),
   no image-quality scoring for enterprise media.
5. **No offline queue / retry.** A submit needs live network; a failed submit is not queued.
   Photos upload one-by-one before the sample row is created — a mid-upload failure means no
   sample is created (safe, but you re-do it).
6. **Minimal validation UI.** The client sends what you enter; server validates lat/lng
   range, gps_source, and media role/path. Rich field validation (enums for rock class,
   alteration, structure) is not surfaced in the beta form — free text / basic fields only.
7. **No edit/delete in-app.** Samples are create + view only. Deletion is service-side.
8. **`config.toml` not fully committed.** The enterprise-samples entry is present but the
   file is entangled with unrelated payment edits (deploy already succeeded regardless).
9. **Auto-created area is a single catch-all.** Every owner submit lands in one
   "Owner Beta Field Collection" area; no area/project selection in the beta.
10. **Not load/perf tested.** Functionally verified (unit 10/10 + shadow + this manual pass);
    no concurrency or large-payload testing.

---

## 10. If something fails
Capture the exact error (app toast, `npx supabase functions logs enterprise-samples`, or the
SQL/curl output) and report it. The most likely first-run snag is the photo upload storage
policy — submitting without a photo isolates that from the core POST→RPC→RLS path.
