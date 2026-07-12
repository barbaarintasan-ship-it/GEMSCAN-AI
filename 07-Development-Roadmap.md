# 07 — Development Roadmap

## Phase 0 — Foundations (pre-code decisions)
- Confirm the payment-policy path (§05, three options) — blocks paywall architecture.
- Begin Mindat.org partnership/licensing outreach (§03) — long lead time, start now regardless of dev timeline.
- Confirm Somali mobile money gateway partner (§05).
- Stand up Supabase project, base schema (§04), auth, RLS policies.

## Phase 1 — Core identification MVP (natural specimens focus, per updated scope)
- Camera capture + gallery upload, on-device YOLO/TFLite pre-filter.
- Single-model (Gemini Flash) Tier-1 scan pipeline via Edge Function orchestrator.
- Reference knowledge base v1: ingest USGS + Smithsonian CC0 + Macrostrat + RRUFF into `reference_species`/`reference_media` (§04), sync jobs scheduled.
- Result screen with top-3 candidates, qualitative confidence band, structured fields, disclaimer.
- Free tier (5 scans/day) enforcement, English + Somali localization from the start.
- Collection/journal feature.

## Phase 2 — Ensemble accuracy & encyclopedia
- Add GPT-5-mini + Claude Sonnet ensemble for premium "deep scan," arbiter logic.
- Full offline encyclopedia (300+ entries) with local caching.
- AI Gemologist chat (RAG over reference knowledge base).
- Web checkout (Stripe/PayPal/mobile money) + subscription verification Edge Function; native IAP per the confirmed policy path.

## Phase 3 — Jewelry/metals/coins/hallmarks expansion
- Extend identification categories to jewelry, coins, hallmarks, precious metals per §02 scope.
- Meteorite classification via NASA public-domain dataset integration.

## Phase 4 — Professional tier
- Inventory management module, multi-user org accounts, RLS org-scoping.
- PDF report generation (branded, localized).
- Batch scanning workflow.

## Phase 5 — Continuous improvement loop
- Consented scan-submission review pipeline feeding proprietary training corpus (§03 §4).
- Per-category accuracy/agreement-rate dashboards (§02 success metrics) to prioritize where the ensemble needs the most improvement.
- Mindat partnership data integration once licensing is finalized.

## Cross-cutting, all phases
- Every screen/string localized (en/so) as it's built, never retrofitted.
- Every new reference data field carries `source_attribution` for licensing auditability.
- Security/RLS review at the end of each phase, not just at launch.

---

Ready for your review. Once you confirm the payment-policy path and anything else you want changed, I'll move to the self-critique pass (already in progress per your last message) and then into source code.
