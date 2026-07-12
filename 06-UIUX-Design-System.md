# 06 — UI/UX Plan & Design System

## Design language
Luxury, minimal, dark-mode-first, gold accents, glassmorphism panels for result cards and modals, restrained premium motion (spring-based transitions, not gratuitous). This directly counter-positions against the category norm identified in §01: competitor apps skew toward busy, ad-interstitial-heavy, zodiac/chakra-decorated UIs. A quieter, more credible visual language signals "serious tool," which matters given professional/hobbyist users are the priority segment (§02).

## Key screens/flows
1. **Camera-first home** — opens directly to camera (matching the Google Lens/PictureThis pattern identified as best-in-class in §01), not a dashboard. Live on-device framing/lighting guidance overlay (from the YOLO pre-filter in §03/§04). Guided **multi-photo capture** (§03): after the first shot, the app prompts for 1–3 additional angles/lighting conditions ("tilt to catch the light," "capture in shade") with a visible progress indicator, skippable for users who just want a quick single-photo scan.
2. **Result screen** — top-3 candidate cards when confidence isn't High (never a single forced answer — this is the #1 trust fix identified in research), qualitative confidence band shown prominently (Low/Medium/High, not a fake percentage), full structured data below (per §02's field list), a persistent "Save to Collection" and "Add to Inventory" (professional) action, and the disclaimer surfaced inline, not hidden.
3. **Collection/journal** — grid/list of saved specimens, filter by category/tag/favorite.
4. **Encyclopedia** — searchable/browsable offline reference (300+ entries), same detail template as scan results for consistency.
5. **AI Gemologist chat** — persistent chat entry point from result screens ("Ask about this specimen") and standalone from nav, with source citations rendered distinctly (e.g., small "per USGS" / "per RRUFF" chips).
6. **Professional dashboard** (gated) — inventory table/grid, batch scan entry, PDF report generation/history, org/staff management.
7. **Account/subscription status** — login, plan display, "Manage subscription" (routes to web for web-originated subscriptions per §05's compliant hybrid model; native IAP management for app-store subscriptions).

## Localization architecture (English/Somali)
- All copy in i18n resource files from day one (e.g., `en.json`/`so.json` keyed strings) — **no hardcoded UI text anywhere**, including AI-generated result copy (structured data fields get localized labels; AI-generated free-text explanations are generated/translated per the user's selected locale).
- PDF reports (professional tier) generated per-locale, not just the app UI — this was explicitly required and is a genuine differentiator since no competitor in §01 supports any non-English localization at all.
- RTL is not needed for Somali (Latin script), simplifying layout work relative to a true RTL language.
- Locale-aware units (metric/carat conventions) and number formatting.

## Accessibility (added per architecture self-review, §08)
Basic WCAG-equivalent mobile accessibility from day one: screen reader labels on all interactive elements, minimum contrast ratios maintained even within the dark/glassmorphism theme, dynamic type/font-scaling support, and non-color-only indicators for confidence bands (e.g., icon + label, not just a color chip) since Low/Medium/High confidence is a core piece of information. This is both good practice and increasingly a hard requirement in B2B/professional vendor contracts.

## Anti-patterns to explicitly avoid (directly from §01 research)
- No credit-card-required "free trial" flow, no dark-pattern billing.
- No ad interstitials between core actions (scan → result → save).
- No more than one clearly-primary pricing choice visible at a time (avoid the 4–6 concurrent SKU confusion seen across competitors).
- Cancellation/plan management always reachable in ≤2 taps from account screen.
