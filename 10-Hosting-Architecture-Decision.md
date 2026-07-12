# Hosting Architecture Decision

Date: 2026-07-12
Status: **Decided — Supabase-only for now.** Fly.io is explicitly deferred, not rejected forever.

## The question

Step 7 of the infrastructure-foundation build asked: does GemScan AI actually
need Fly.io, or is there a simpler architecture that's cheaper, scalable, and
easier to maintain?

## What the evidence actually shows

- **Every backend responsibility GemScan AI currently has is already a
  Supabase Edge Function.** `orchestrate-scan` (the core AI pipeline),
  `verify-subscription`, `create-checkout-session`, `stripe-webhook`,
  `mobile-money-webhook` — all 5 exist, all deploy via
  `supabase functions deploy`, none need a persistent server process.
- **`04-Technical-Architecture-Database-Security.md`** (the project's own
  architecture doc, written before this infra work started) describes the
  backend exclusively in terms of "Edge Functions (Deno) — orchestration,
  subscription verification, PDF generation, scheduled data-sync jobs."
  Zero mentions of Fly.io, a VM, or a long-running server anywhere in the
  project's docs.
- **No `fly.toml` exists anywhere in this project**, and the one Fly.io app
  on this machine's authenticated account (`barbaarintasan-staging`) belongs
  to a different, unrelated project (the Ministar Childcare App — confirmed
  in `FINAL-DEVOPS-VERIFICATION-REPORT.md` §6). There is no existing
  GemScan Fly.io footprint to build on or migrate.
- **Auth, Storage, Postgres, and scheduled jobs** are all already covered by
  Supabase itself (Supabase Auth, Supabase Storage's `scan-images` bucket,
  Supabase Postgres with RLS, `pg_cron`/Supabase scheduled functions for any
  future data-sync jobs) — nothing here requires a separate compute layer.

## Architectures compared

| | Supabase-only | Fly.io backend | Hybrid |
|---|---|---|---|
| Matches what's already built | Yes — exactly | No — would require rewriting Edge Functions as a server | Partially |
| Ops overhead | Lowest (managed, no servers to patch/scale) | Highest (owns uptime, scaling, deploys, secrets rotation for a VM) | Medium, and now *two* deploy pipelines to keep in sync |
| Cost at current scale (pre-revenue app) | Free tier covers dev/staging entirely | A paid Fly app running 24/7 regardless of traffic | Pays for both |
| Cold-start / latency | Edge Functions run close to Supabase Postgres, no cross-network hop | N/A (own infra) | Adds a hop between Fly and Supabase for every DB call |
| Maintainability for a solo/small team | Single platform to reason about | Two platforms (Supabase + Fly) to keep in sync | Same as Fly.io |

Supabase-only wins on all four axes the user asked to optimize for:
**simplest, cheapest, most scalable at this stage, and most maintainable.**

## Decision

**Use Supabase exclusively as GemScan AI's backend for the mobile app and
Edge Function layer.** Do not create any Fly.io resources for GemScan AI at
this time.

## When to revisit this (not "never")

The only scenario in this project's own docs that doesn't cleanly fit an
Edge Function is the **Professional module's PDF report generation**
(`04-Technical-Architecture-Database-Security.md` explicitly hedges this
with "or a dedicated render service"), since PDF rendering can be
memory/CPU-heavy and slow compared to Edge Functions' execution limits. If
that becomes a real bottleneck once the Professional tier is built, Fly.io
(or a similar single-purpose render service) would be a reasonable, narrow
addition at that point — not a wholesale backend migration.

The future **GemScan website** (mentioned as a separate, not-yet-started
milestone in prior instructions) is also out of scope for this decision;
its own hosting choice should be made when that milestone actually starts,
based on what that codebase turns out to need (likely still
Vercel/Supabase-adjacent rather than Fly, but that's a decision for then,
not now).

## What NOT to do

Do not create a Fly.io app "just in case," and do not reuse or extend
`barbaarintasan-staging` for GemScan AI — that app belongs to a different
project and mixing them would create an ownership/billing ambiguity with no
upside.
