# GemScan AI — Master Research & Product Design Package

This is the complete research-and-architecture deliverable requested before any code is written. Read in this order:

1. [01-Market-Research-and-Competitive-Analysis.md](01-Market-Research-and-Competitive-Analysis.md) — competitor teardown, market gaps, pricing landscape
2. [02-Product-Requirements-Document.md](02-Product-Requirements-Document.md) — PRD, feature spec, target users, scope boundaries
3. [03-AI-Architecture-and-Data-Sources.md](03-AI-Architecture-and-Data-Sources.md) — multi-model AI orchestration, scientific data source integration, licensing, continuous-learning knowledge base
4. [04-Technical-Architecture-Database-Security.md](04-Technical-Architecture-Database-Security.md) — tech stack, Supabase schema, security plan
5. [05-Monetization-Legal-Payments.md](05-Monetization-Legal-Payments.md) — pricing, payment rails, **critical App Store policy risk flagged**
6. [06-UIUX-Design-System.md](06-UIUX-Design-System.md) — design language, screen flows, localization approach
7. [07-Development-Roadmap.md](07-Development-Roadmap.md) — phased build plan
8. [08-Self-Critique-and-Design-Improvements.md](08-Self-Critique-and-Design-Improvements.md) — critical review of the whole architecture (accuracy, scalability, legal, commercial gaps) — its findings are already merged into docs 02–06
9. [09-AI-Scan-Pipeline-Production-Verification-Report.md](09-AI-Scan-Pipeline-Production-Verification-Report.md) — post-implementation production verification pass over the AI Scan Pipeline (types, lint, migrations/RLS, builds, tests, memory/performance/security review, dead/duplicate code cleanup) — completed before the website/checkout milestone began
10. [FINAL-DEVOPS-VERIFICATION-REPORT.md](FINAL-DEVOPS-VERIFICATION-REPORT.md) — DevOps/CI-CD/staging readiness check. **Finding: this layer does not exist yet** — no git repo, no GitHub connection, no CI automation, no live Supabase project, no Fly.io setup for this project, no mobile build pipeline, no monitoring. Read before assuming any deployment infrastructure is in place.

## Critical decisions that need your sign-off before code starts

These are flagged inline in the relevant docs but repeated here because they change the build:

1. **App Store/Play Store external-payment risk** (§05) — "no subscriptions in-app, website-only payment" as literally specified will likely get the app **rejected or removed** by Apple in most regions. There's a narrow, region-limited exception. You need to pick one of three paths before we architect the paywall.
2. **Mindat.org is not free for commercial use** (§03) — it's the single best mineral/locality database but requires a paid partnership negotiation, not just an API key. Budget time for BD outreach.
3. **GIA has no usable data-licensing path** for this product (§03) — drop "GIA resources integration" as a literal data feed; keep as citation/education links only.
4. **Honest accuracy ceiling is ~65–85%** for common natural species in good conditions, and natural-vs-synthetic / treatment detection is **not achievable from a photo at all** (§03) — this must be reflected in marketing copy and in-app disclaimers, not buried in fine print.

Everything else in this package is ready to execute against. Once you've reviewed and confirmed direction on the 4 items above (and anything else you want changed), tell me and I'll move to source code.
