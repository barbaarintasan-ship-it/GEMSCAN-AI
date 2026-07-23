# ADR-0002 — Foreign-key ON DELETE policy (data-preserving)

| | |
|---|---|
| **Status** | Accepted |
| **Date** | Sprint 2 (Phase 1) |
| **Deciders** | Engineering Lead (user) + implementing engineer |
| **Affected** | All Sprint-2 migrations (`0019`–`0032`) |

## Context

Enterprise tables reference `auth.users` (identity) and each other. The
architecture defined the *entities and relationships* but not the exact
`ON DELETE` behaviour of each FK. A deletion of a user account (or a parent row)
must not silently destroy valuable, hard-won geological evidence.

## Decision

A consistent, **data-preserving** ON DELETE policy:

| FK kind | Policy | Reason |
|---|---|---|
| **Ownership / creator / actor** (`owner_id`, `created_by`, `creator_id`, `collector_id`, `reviewer_id`, `verified_by`, `actor_id`, `signer_id`, `sealed_by`, `resolved_by`) → `auth.users` | **`ON DELETE SET NULL`** (columns nullable) | Enterprise evidence outlives an individual account; the record survives, attribution is cleared. |
| **Membership / junction** (`organization_member`, `area_membership`, `mission_contributor`, `mission_area`) | **`ON DELETE CASCADE`** | A membership/link is meaningless without its user/parent. |
| **Owning parent → child** (e.g. `sample` → `sample_location`/`sample_media`; `exploration_area` → `sample`; `organization` → `project`) | **`ON DELETE CASCADE`** | The child cannot exist without its parent. |
| **Optional cross-reference** (e.g. `sample.mission_id`, `sample.formation_id`, `field_observation_point.sample_id`) | **`ON DELETE SET NULL`** | The link is optional; the row remains valid without it. |
| **Lookup reference** (e.g. `occurrence_evidence.evidence_type` → `evidence_tier`) | default (RESTRICT) | Lookups are stable; blocking deletion of a referenced lookup is correct. |

## Consequences

- ✅ Deleting a user never destroys samples, areas, evidence, or audit history —
  it only nulls attribution.
- ✅ Deleting a true owning parent cleanly removes its dependents.
- Ownership columns are therefore **nullable** (a minor, deliberate deviation
  from any "NOT NULL owner" sketch in the spec; integrity of *who owns now* is an
  application concern, not a hard DB constraint).

## Note

"Reviewer must not be the collector" (no self-verify) and similar cross-row
business rules are enforced in **Edge Functions**, not as DB constraints.
