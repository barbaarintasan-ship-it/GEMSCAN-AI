# Historical Intelligence — Production Rollout Runbook

**Status: PROPOSAL — nothing here has been executed against production.**
Migrations `0159`/`0160` are branch-verified and committed to git (`a22b2eb`) but **not applied to production**. This runbook is the safe path to deploy them when you give an explicit go.

---

## 0. Preconditions (before ANY step)
1. **Restore + reconnect the production MCP:** the config is already restored to production read-only (`~/.claude.json`); **restart Claude Code**, then confirm `get_project_url` → `https://znqkzgswvhbkhxldbbld.supabase.co`.
2. For any step that WRITES to production, the read-only MCP must be temporarily switched to `read_only=false` **pointed at production** (a conscious, logged decision), OR the migration applied via the Supabase dashboard SQL editor / `supabase` CLI against production.
3. **Explicit go** from the owner for each production-writing step.

---

## 1. Does the migration-drift fix have to come first? — NO, not for this deploy
- The drift breaks **fresh branch provisioning** (a from-scratch replay fails at `0003` because the Supabase runner can't create the `auth.users` triggers in `0001`).
- Production **already has** the full schema (`geo`, `enterprise`, `mineral_occurrence` = 159, `occurrences_near`, etc.). Applying `0159`/`0160` to production only needs objects that **already exist** there.
- ∴ `0159`/`0160` can be deployed to production **without** first fixing the drift. The drift fix is a **separate** infra project (needed only to make branching/CI replay work again).

---

## 2. Deploy 0159 + 0160 to production (two path options)

### Path A — direct apply (recommended; bypasses the broken CI pipeline)
Apply the two verified migrations straight to production, then record them in tracking.
1. Baseline snapshot (read-only):
   ```sql
   select count(*) as mrds from geo.mineral_occurrence;              -- expect 159
   select count(*) as occ_near from geo.occurrences_near(8,47,2000000); -- expect 159
   ```
2. Apply `0159` then `0160` (dashboard SQL editor against production, or `supabase migration up`, or MCP `apply_migration` with production + writes enabled). They are idempotent (WHERE NOT EXISTS / IF NOT EXISTS) and were branch-proven.
3. Record versions in `supabase_migrations.schema_migrations` if applying outside the CLI (so tracking stays consistent):
   ```sql
   insert into supabase_migrations.schema_migrations(version, name)
   values ('0159','historical_intelligence_provenance'),
          ('0160','historical_mineral_record_and_georef_queue')
   on conflict do nothing;
   ```
   *(Note: this continues the existing NNNN-vs-timestamp drift; acceptable short-term, resolved by §4.)*

### Path B — via GitHub/CI pipeline
Only viable **after** the drift fix (§4). Merge `perf/boot-freeze` → the deploy branch and let the Supabase integration apply migrations. Currently the pipeline shows `Migrations: failed`, so **do not** rely on this until §4 is done.

---

## 3. Post-deploy validation (production) — must all hold
```sql
select count(*) from geo.mineral_occurrence;                 -- 159 (UNCHANGED)
select count(*) from geo.occurrences_near(8,47,2000000);     -- 159 (UNCHANGED — firewall)
select count(*) from geo.historical_mineral_record;          -- 6, all provisional, all geom NULL
select count(*) from geo.historical_mineral_record where geom is not null;      -- 0
select count(*) from geo.historical_mineral_record where evidence_type='geochemical_anomaly'; -- 2
select count(*) from geo.map_georef_queue;                    -- 3
```
Then run `supabase/tests/historical_intelligence_firewall.verify.sql` against production — it must print PASS. **If `mineral_occurrence` ≠ 159 or `occurrences_near` changed, STOP and roll back.**

Confirm no production score changed: historical tables are read by **no** RPC/Edge Function; `occurrences_near` still returns only `mineral_occurrence` rows. Historical scoring stays OFF.

---

## 4. (Separate project) Fix migration-replay drift so branching/CI work again
Root cause: `0001` creates triggers on `auth.users`; the Supabase branch/CI runner lacks that privilege, so fresh replays fail at `0003`. Because you cannot edit already-applied migrations, the clean fix is a **baseline squash**:
1. `supabase db dump --schema public,geo,enterprise,ml,extensions` from production → one `0000_baseline.sql` (schema) + preserve the data-load migrations (e.g. `0071` MRDS).
2. Archive `0001`–`0158` (do not delete/edit); repo becomes `0000_baseline` + data-loads + `0159`/`0160`.
3. `supabase migration repair` so tracking matches the baseline.
4. **Test on a throwaway branch first** — it must reach `ACTIVE_HEALTHY` with `geo.mineral_occurrence = 159` before touching production tracking.
This is HIGH-RISK (touches production `schema_migrations`) — do it deliberately, throwaway-tested, with rollback ready.

---

## 5. Rollback (if validation fails)
```sql
-- 0160 (firewalled tables — safe to drop; nothing else references them)
drop table if exists geo.map_georef_queue;
drop table if exists geo.historical_mineral_record;
-- 0159 (provenance rows)
delete from geo.knowledge_source ks using geo.dataset_registry d
  where ks.dataset_id = d.id and d.source_key = 'somalia_historical_sources';
delete from geo.dataset_registry where source_key in ('hadden_2007_biblio','somalia_historical_sources');
-- tracking, if inserted manually
delete from supabase_migrations.schema_migrations where version in ('0159','0160');
```
Rollback removes only the additive historical layer; MRDS, commodity profiles, scoring, and all existing objects are untouched throughout.

---

## 6. What stays OUT of scope (still deferred, explicit go each)
- Activating historical-occurrence **scoring** (a future opt-in phase; today historical data is queryable/firewalled, never scored).
- Georeferencing the Dalan cassiterite plate / other map-queue items → real `map_derived` coordinates.
- Gazetteer-resolving Milxo / Irshida / Mait / Batalale → `placename_gazetteer` coordinates with uncertainty.
- Recovering GEOSOM-87 proceedings, Chakrabarti 1988, company filings (research follow-ups).

## Invariant for every step
Historical intelligence is **additional evidence, never replacement truth** — it must enrich Luul Scan without changing MRDS, `occurrences_near`, scoring, or inventing a coordinate.
