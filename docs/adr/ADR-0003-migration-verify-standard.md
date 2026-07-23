# ADR-0003 — Every migration ships a VERIFY query (CI/CD)

| | |
|---|---|
| **Status** | Accepted |
| **Date** | Sprint 2 (Phase 1) |
| **Deciders** | Engineering Lead (user) + implementing engineer |
| **Applies to** | All enterprise migrations from `0022` onward (retro-note: 0019–0021 verified by ad-hoc queries) |

## Context

Migrations must be verifiable — by a human during review and, later, by
automated CI/CD — without hand-writing checks each time.

## Decision

Every migration file embeds a **`-- VERIFY (CI/CD)`** comment block containing a
single SQL query that returns a row of **expected counts** for the objects that
migration creates. It covers, as relevant:

- table count (in the target schema),
- key index count (incl. GIST / GIN / BRIN),
- constraint counts (CHECK / UNIQUE),
- foreign-key counts (e.g. `→ sample`, `→ auth.users`),
- PostGIS objects (GIST indexes), functions/triggers.

Each migration also embeds a **`-- ROLLBACK (down-path)`** comment block with the
exact reverse-order drop statements.

### Standard test cycle (per migration, on the local shadow DB)

```
apply → run VERIFY query → idempotency (re-apply, expect no-op) →
rollback (run down-path) → re-apply
```

with, where meaningful, a **functional** check (e.g. PostGIS `ST_DWithin`, a CHECK
rejection, a trigger firing). Consumer isolation is asserted every cycle
(`public` base-table count unchanged).

## Consequences

- ✅ Uniform, machine-checkable verification embedded in each migration.
- ✅ CI/CD can extract and run the VERIFY query after applying a migration and
  assert the expected counts.
- ✅ The documented rollback is testable and kept next to the forward migration.

## Convention companions (also standardised in Sprint 2)

- **Idempotency:** `CREATE TABLE/INDEX IF NOT EXISTS`; enum types guarded by
  `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$`.
- **PostGIS types** are schema-qualified `extensions.geography` / `extensions.geometry`
  (PostGIS installed in the `extensions` schema).
- **UUID PKs** via core `gen_random_uuid()` (PG13+); IDs on offline-captured
  entities are client-suppliable for idempotent upsert.
