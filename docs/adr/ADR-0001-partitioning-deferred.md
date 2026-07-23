# ADR-0001 — Defer time-partitioning of `sample` / `sample_media`

| | |
|---|---|
| **Status** | Accepted |
| **Date** | Sprint 2 (Phase 1) |
| **Deciders** | Engineering Lead (user) + implementing engineer |
| **Amends** | Amendment A2 §2.6 / §8.3 ("partition from day one") |
| **Affected** | `0023_samples.sql` and every child table that FKs `sample(id)` |

## Context

A2 §2.6/§8.3 mandated **month time-partitioning of `enterprise.sample` (and
`sample_media`) from day one** for 10M-row scalability.

However, `sample` is referenced by **single-column `sample_id` foreign keys** from
~13 child tables (`sample_location`, `sample_media`, `sample_device_context`,
`rock_observation`, `mineral_observation`, `alteration_observation`,
`structural_measurement`, `occurrence_evidence`, `sample_verification`,
`lab_result`, `sample_container`, `sample_chain_event`, `field_observation_point`).

In PostgreSQL a **foreign key must reference a UNIQUE constraint**, and a unique
constraint on a **partitioned** table **must include the partition key**. So
partitioning `sample` by `collected_at` forces:

- `sample` PK/unique → `(id, collected_at)`, and
- every child FK → `(sample_id, sample_collected_at)` — i.e. denormalizing
  `collected_at` into ~13 child tables and using composite FKs.

This directly conflicts with the clean single-column `sample_id` FK model used
throughout the design.

## Decision

**Defer partitioning (Option A).** For Phase 1, `sample` uses a simple
**`PK(id)`** and all child tables keep **single-column `sample_id` FKs** with full
referential integrity.

Time-partitioning will be introduced in a **dedicated pre-production migration**,
executed **while the table is still empty/small** (a painless recreate), before
any production data accumulates.

## Rationale

- Phase 1 holds **no data**, so the "retrofit pain" A2 §8.3 warned about (which
  applies to a **large, live** table) does not apply now.
- Preserves **referential integrity** and a simple, correct FK model across ~13
  child tables — the project's stated priority to never lose valuable data.
- Keeps Sprint 2 migrations small and reviewable.

## Consequences

- ✅ Clean FKs, full integrity, simpler Sprint 2.
- ⚠️ A follow-up "partition `sample`/`sample_media`" migration is **required before
  production scale**; tracked as a pre-production task. Because it runs on an
  empty/small table, it is a low-risk recreate.
- The scalability target (10M samples) is **unchanged** — partitioning simply
  moves from "day one" to "before production data".

## Alternatives considered

- **Option B — partition now with composite FKs**: denormalize `collected_at`
  into ~13 children + composite FKs. Rejected: heavy, error-prone, obscures the
  model for zero Phase-1 benefit.
- **Option C — partition, no FKs to `sample`**: enforce integrity in app/Edge.
  Rejected: loses referential integrity — unacceptable for an enterprise dataset.
